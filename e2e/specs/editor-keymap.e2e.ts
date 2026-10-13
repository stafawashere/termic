import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

type Range = { anchor: number; head: number };

const KEYMAP_SELECT = '[data-testid="editor-keymap-select"]';

// Editor key presets. Default keeps CodeMirror's keys; Zed layers Zed's macOS
// bindings above them. Cases: the Settings row switches the preset, the
// default preset leaves cmd-d and Alt-Up alone, and the Zed preset drives
// multi-cursor and syntax selection through the real key path.
describe("editor keymap preset", () => {
  let taskId!: string;
  after(async () => {
    await browser.execute(() => window.__termic!.usePrefs.getState().setEditorKeymap("default"));
    if (taskId) await archiveTask(taskId);
  });

  const readmeSel = '[data-path="README.md"]';

  const hostSel = () => `[data-task-id="${taskId}"] .cm-editor`;

  const setDoc = async (doc: string, anchor: number) => {
    await browser.execute((sel, text, at) => {
      const host = document.querySelector(sel) as HTMLElement;
      const view = (host as unknown as { __cmView: any }).__cmView;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: at },
      });
      (host.querySelector(".cm-content") as HTMLElement).focus();
    }, hostSel(), doc, anchor);
  };

  const ranges = (): Promise<Range[]> =>
    browser.execute((sel) => {
      const host = document.querySelector(sel) as HTMLElement;
      const view = (host as unknown as { __cmView: any }).__cmView;
      return view.state.selection.ranges.map((r: any) => ({ anchor: r.anchor, head: r.head }));
    }, hostSel());

  const docText = (): Promise<string> =>
    browser.execute((sel) => {
      const host = document.querySelector(sel) as HTMLElement;
      return (host as unknown as { __cmView: any }).__cmView.state.doc.toString();
    }, hostSel());

  const press = (key: string, mods: { mod?: boolean; alt?: boolean }) =>
    browser.execute((sel, k, m) => {
      const content = document.querySelector(sel + " .cm-content") as HTMLElement;
      const isMac = /^(mac|darwin)/i.test(navigator.platform);
      content.dispatchEvent(new KeyboardEvent("keydown", {
        key: k,
        metaKey: !!m.mod && isMac,
        ctrlKey: !!m.mod && !isMac,
        altKey: !!m.alt,
        bubbles: true,
        cancelable: true,
      }));
    }, hostSel(), key, mods);

  const chooseKeymap = async (value: "default" | "zed") => {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("appearance"));
    await browser.waitUntil(
      () => browser.execute((sel) => document.querySelector(sel) !== null, KEYMAP_SELECT),
      { timeout: 10_000, timeoutMsg: "the editor keymap select never rendered" },
    );
    await browser.execute((sel, v) => {
      const select = document.querySelector(sel) as HTMLSelectElement;
      const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setValue.call(select, v);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, KEYMAP_SELECT, value);
    await browser.waitUntil(
      () => browser.execute((v) => window.__termic!.usePrefs.getState().editorKeymap === v, value),
      { timeout: 5_000, timeoutMsg: `the Settings select never set the ${value} preset` },
    );
    await snap(`editor-keymap-settings-${value}.png`);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await browser.waitUntil(
      () => browser.execute(() => window.__termic!.useApp.getState().view.settingsOpen !== true),
      { timeout: 5_000, timeoutMsg: "settings never closed" },
    );
  };

  it("opens an editor on the default preset", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-keymap");

    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), readmeSel),
      { timeout: 15_000, timeoutMsg: "README row never appeared" },
    );
    await browser.execute((s) => (document.querySelector(s) as HTMLElement).click(), readmeSel);
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), hostSel()),
      { timeout: 10_000, timeoutMsg: "the editor never mounted" },
    );

    const preset = await browser.execute(() => window.__termic!.usePrefs.getState().editorKeymap);
    expect(preset).toBe("default");
    await chooseKeymap("default");
  });

  it("keeps CodeMirror's keys under the default preset", async () => {
    await setDoc("foo bar\nfoo baz\nfoo qux\n", 0);
    await press("d", { mod: true });
    expect(await ranges()).toEqual([{ anchor: 0, head: 3 }]);

    await setDoc("one\ntwo\n", 5);
    await press("ArrowUp", { alt: true });
    expect(await docText()).toBe("two\none\n");
  });

  it("switches to Zed from Settings and selects occurrences with cmd-d", async () => {
    await chooseKeymap("zed");

    await setDoc("foo bar\nfoo baz\nfoo qux\n", 0);
    await press("d", { mod: true });
    await press("d", { mod: true });
    expect(await ranges()).toEqual([
      { anchor: 0, head: 3 },
      { anchor: 8, head: 11 },
    ]);
  });

  it("adds a cursor below with cmd-alt-down while the editor has focus", async () => {
    await setDoc("alpha beta\ngamma delta\nzeta\n", 2);
    await press("ArrowDown", { mod: true, alt: true });
    expect(await ranges()).toEqual([
      { anchor: 2, head: 2 },
      { anchor: 13, head: 13 },
    ]);
  });

  it("expands the selection with Alt-Up and shrinks it with Alt-Down", async () => {
    await setDoc("alpha beta\n\ngamma\n", 2);

    await press("ArrowUp", { alt: true });
    const firstGrow = await ranges();
    expect(firstGrow).toEqual([{ anchor: 0, head: 10 }]);

    await press("ArrowUp", { alt: true });
    const secondGrow = await ranges();
    expect(secondGrow[0].head - secondGrow[0].anchor).toBeGreaterThan(10);

    await press("ArrowDown", { alt: true });
    expect(await ranges()).toEqual(firstGrow);
    expect(await docText()).toBe("alpha beta\n\ngamma\n");
  });

  it("returns to CodeMirror's keys when switched back", async () => {
    await chooseKeymap("default");
    await setDoc("one\ntwo\n", 5);
    await press("ArrowUp", { alt: true });
    expect(await docText()).toBe("two\none\n");
  });
});
