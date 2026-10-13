import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell, rmTree } from "../helpers";

const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");
const dirName = "e2e-multibuffer";
const term = "multibufferneedle";

describe("multibuffer tab", () => {
  let taskId!: string;
  const firstFile = path.join(fixture, dirName, "first.txt");
  const secondFile = path.join(fixture, dirName, "second.txt");

  const multibufferTab = () =>
    browser.execute((id) => {
      const state = window.__termic!.useApp.getState();
      return (state.tabs[id] ?? []).find((tab: any) => tab.type === "multibuffer") ?? null;
    }, taskId);

  const editExcerpt = (file: string, from: string, to: string) =>
    browser.execute((filePath, needle, replacement) => {
      const host = document.querySelector(
        `[data-testid="multibuffer-excerpt"][data-path="${filePath}"] .cm-editor`,
      ) as unknown as { __cmView?: any } | null;
      const view = host?.__cmView;
      if (!view) throw new Error("excerpt view was not mounted");

      const text = view.state.doc.toString();
      const start = text.indexOf(needle);
      if (start < 0) throw new Error(`"${needle}" not in excerpt of ${filePath}`);
      view.dispatch({ changes: { from: start, to: start + needle.length, insert: replacement } });
    }, file, from, to);

  before(async () => {
    mkdirSync(path.join(fixture, dirName), { recursive: true });
    writeFileSync(firstFile, `alpha\nbeta ${term} gamma\ndelta\n`);
    writeFileSync(secondFile, `l1\nl2\nl3\nl4\nl5\n${term} l6\nl7\nl8\nl9\nl10\n`);
    execSync(`git -C "${fixture}" add ${dirName}`);
  });

  after(async () => {
    execSync(`git -C "${fixture}" reset -q -- ${dirName}`);
    rmTree(path.join(fixture, dirName));
    if (taskId) await archiveTask(taskId);
  });

  it("opens every match of a find-in-files search as one tab", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-multibuffer");

    await browser.execute((id) => window.__termic!.useUI.getState().openFindInFiles(id), taskId);

    const inputSel = 'input[placeholder^="Find in"]';
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), inputSel),
      { timeout: 8_000, timeoutMsg: "find-in-files never opened" },
    );

    await browser.execute((s, v) => {
      const input = document.querySelector(s) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, inputSel, term);

    const buttonSel = '[data-testid="fif-open-multibuffer"]';
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), buttonSel),
      { timeout: 10_000, timeoutMsg: "Open as Multibuffer never appeared for the search" },
    );

    await browser.execute((s) => (document.querySelector(s) as HTMLElement).click(), buttonSel);

    await browser.waitUntil(async () => (await multibufferTab()) !== null, {
      timeout: 8_000,
      timeoutMsg: "no multibuffer tab was opened",
    });

    const excerptCount = await browser.execute(
      () => document.querySelectorAll('[data-testid="multibuffer-excerpt"]').length,
    );
    expect(excerptCount).toBe(2);
    await snap("multibuffer-open.png");
  });

  it("offsets line numbers to the real lines of the file", async () => {
    await browser.waitUntil(
      () => browser.execute(() => document.querySelectorAll(".cm-lineNumbers .cm-gutterElement").length > 0),
      { timeout: 8_000, timeoutMsg: "excerpt views never mounted" },
    );

    const secondNumbers = await browser.execute((filePath) =>
      [...document.querySelectorAll(
        `[data-path="${filePath}"] .cm-lineNumbers .cm-gutterElement`,
      )].slice(1).map((el) => el.textContent?.trim()),
    `${dirName}/second.txt`);
    expect(secondNumbers[0]).toBe("3");
  });

  it("marks the tab dirty after an edit and saves every touched file", async () => {
    await editExcerpt(`${dirName}/first.txt`, term, "firstedit");
    await editExcerpt(`${dirName}/second.txt`, term, "secondedit");

    await browser.waitUntil(async () => (await multibufferTab())?.dirty === true, {
      timeout: 5_000,
      timeoutMsg: "edit never marked the multibuffer dirty",
    });

    await browser.execute(() => {
      const content = document.querySelector('[data-testid="multibuffer-pane"] .cm-content')!;
      const isMac = /^(mac|darwin)/i.test(navigator.platform);
      content.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", [isMac ? "metaKey" : "ctrlKey"]: true, bubbles: true }),
      );
    });

    await browser.waitUntil(async () => (await multibufferTab())?.dirty === false, {
      timeout: 8_000,
      timeoutMsg: "saving never cleared the dirty flag",
    });

    expect(readFileSync(firstFile, "utf8")).toBe("alpha\nbeta firstedit gamma\ndelta\n");
    expect(readFileSync(secondFile, "utf8")).toBe("l1\nl2\nl3\nl4\nl5\nsecondedit l6\nl7\nl8\nl9\nl10\n");
    await snap("multibuffer-saved.png");
  });

  it("reports a conflict and keeps the tab dirty when the file moved on", async () => {
    await editExcerpt(`${dirName}/first.txt`, "firstedit", "again");
    writeFileSync(firstFile, "changed\nunderneath\nthe\nexcerpt\n");

    await browser.execute(() => {
      const content = document.querySelector('[data-testid="multibuffer-pane"] .cm-content')!;
      const isMac = /^(mac|darwin)/i.test(navigator.platform);
      content.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", [isMac ? "metaKey" : "ctrlKey"]: true, bubbles: true }),
      );
    });

    await browser.waitUntil(
      () => browser.execute(() =>
        window.__termic!.useUI.getState().toasts.some((toast: any) => String(toast.msg).includes("changed on disk")),
      ),
      { timeout: 8_000, timeoutMsg: "no conflict toast after saving over a changed file" },
    );

    expect((await multibufferTab())?.dirty).toBe(true);
    expect(readFileSync(firstFile, "utf8")).toBe("changed\nunderneath\nthe\nexcerpt\n");
  });
});
