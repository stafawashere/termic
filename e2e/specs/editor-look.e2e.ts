import { archiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

const readmeSel = '[data-path="README.md"]';

// Indent guides and the minimap are two prefs, each its own compartment in
// EditorPane. Cases: guides are on by default and draw from the theme vars,
// the minimap is absent until enabled, enabling it adds a canvas without
// adding .cm-line nodes, and both turn off again without rebuilding the view.
describe("editor look: indent guides and minimap", () => {
  let taskId!: string;
  after(async () => {
    await browser.execute(() => {
      const prefs = window.__termic!.usePrefs.getState();
      prefs.setEditorIndentGuides(true);
      prefs.setEditorMinimap(false);
    });
    if (taskId) await archiveTask(taskId);
  });

  const hostSel = () => `[data-task-id="${taskId}"] .cm-editor`;

  const exists = (selector: string) =>
    browser.execute((sel) => document.querySelector(sel) !== null, selector);

  const lineCount = () =>
    browser.execute((sel) => document.querySelectorAll(sel + " .cm-line").length, hostSel());

  const waitFor = (selector: string, present: boolean, timeoutMsg: string) =>
    browser.waitUntil(async () => (await exists(selector)) === present, { timeout: 10_000, timeoutMsg });

  it("opens a long indented file with guides on and no minimap", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-look");

    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), readmeSel),
      { timeout: 15_000, timeoutMsg: "README row never appeared" },
    );
    await browser.execute((s) => (document.querySelector(s) as HTMLElement).click(), readmeSel);
    await waitFor(hostSel(), true, "the editor never mounted");

    await browser.execute((sel) => {
      const host = document.querySelector(sel) as HTMLElement;
      const view = (host as unknown as { __cmView: any }).__cmView;
      const body = Array.from({ length: 400 }, (_, index) => "    ".repeat(index % 5) + `line ${index}`).join("\n");
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: body } });
    }, hostSel());

    const prefs = await browser.execute(() => {
      const state = window.__termic!.usePrefs.getState();
      return { guides: state.editorIndentGuides, minimap: state.editorMinimap };
    });
    expect(prefs).toEqual({ guides: true, minimap: false });

    await waitFor(`${hostSel()} .cm-indent-markers`, true, "indent guides never rendered");
    expect(await exists(`${hostSel()} .cm-minimap-gutter`)).toBe(false);
    await snap("editor-look-guides-only.png");
  });

  it("draws guides from the theme variables", async () => {
    const color = await browser.execute((sel) => {
      const markers = document.querySelector(sel + " .cm-indent-markers") as HTMLElement;
      return markers.ownerDocument.defaultView!.getComputedStyle(document.documentElement)
        .getPropertyValue("--color-indent-guide").trim();
    }, hostSel());
    expect(color).not.toBe("");
  });

  it("shows a canvas minimap without adding line nodes", async () => {
    const linesBefore = await lineCount();

    await browser.execute(() => window.__termic!.usePrefs.getState().setEditorMinimap(true));
    await waitFor(`${hostSel()} .cm-minimap-gutter canvas`, true, "the minimap canvas never appeared");

    const linesAfter = await lineCount();
    expect(linesAfter).toBe(linesBefore);
    expect(linesAfter).toBeLessThan(400);
    await snap("editor-look-minimap.png");
  });

  it("removes the minimap and the guides in place", async () => {
    await browser.execute(() => window.__termic!.usePrefs.getState().setEditorMinimap(false));
    await waitFor(`${hostSel()} .cm-minimap-gutter`, false, "the minimap never went away");

    await browser.execute(() => window.__termic!.usePrefs.getState().setEditorIndentGuides(false));
    await waitFor(`${hostSel()} .cm-indent-markers`, false, "indent guides never went away");
    await snap("editor-look-both-off.png");
  });
});
