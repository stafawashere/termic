// The footer strip (docs/ui.md "The footer strip"): the sidebar's bar and
// the task's bar, one 46px strip across the window.
//
// Sidebar half: its wells, button order and sizes, the What's New unread dot
// on the mail button, the Contact control in the Changelog dialog, and the
// activity button. The unread state comes from the update store's
// localStorage watermark, so the spec seeds an old seen version and reloads.
// The running version is the e2e build's real one, always newer than 0.0.1.
//
// Task half: the Queue / Terminal segments, the queue count, the usage
// readout's meter and its levels, and the sandbox chip.

import {
  archiveTask,
  clickWhenVisible,
  dismissOverlays,
  ensureActiveTask,
  openTask,
  requireTermicApi,
  snap,
  waitForAgentPty,
  waitForAppShell,
  waitForAttr,
  waitGone,
  waitVisible,
} from "../helpers.js";

const SIDEBAR_FOOTER = '[data-testid="sidebar-footer"]';
const MAIL = '[data-testid="footer-whats-new"]';
const DOT = '[data-testid="footer-whats-new-dot"]';
const CONTACT = '[data-testid="changelog-contact"]';
const LAST_SEEN_KEY = "updateLastSeenVersion";

const readLastSeen = () =>
  browser.execute(key => localStorage.getItem(key), LAST_SEEN_KEY);

const writeLastSeen = (version: string | null) =>
  browser.execute((key, value) => {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }, LAST_SEEN_KEY, version);

async function reloadApp() {
  await browser.refresh();
  await waitForAppShell();
  await requireTermicApi();
  await dismissOverlays();
}

/** The task footer that paints: every visited task keeps its own mounted. */
function taskFooter(taskId: string): string {
  return `[data-task-id="${taskId}"] [data-testid="task-footer"]`;
}

describe("footer strip", () => {
  let lastSeenWas: string | null = null;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    await browser.execute(() => {
      const app = window.__termic!.useApp.getState();
      if (app.compactSidebar) app.toggleCompactSidebar();
    });

    lastSeenWas = await readLastSeen();
  });

  after(async () => {
    await writeLastSeen(lastSeenWas);
  });

  describe("sidebar footer", () => {
    it("holds two wells: five buttons, then settings alone at the far edge", async () => {
      await waitVisible(SIDEBAR_FOOTER);

      const layout = await browser.execute(sel => {
        const footer = document.querySelector(sel) as HTMLElement;
        const footerBox = footer.getBoundingClientRect();
        const wells = [...footer.querySelectorAll<HTMLElement>(".footer-well")];
        const buttons = [...footer.querySelectorAll<HTMLButtonElement>("button[data-testid]")];
        const settingsWell = wells[wells.length - 1].getBoundingClientRect();
        return {
          height: footerBox.height,
          wells: wells.map(well => [...well.querySelectorAll("button[data-testid]")].map(b => (b as HTMLElement).dataset.testid)),
          wellHeights: wells.map(well => well.getBoundingClientRect().height),
          sizes: buttons.map(button => {
            const box = button.getBoundingClientRect();
            return `${box.width}x${box.height}`;
          }),
          iconSizes: buttons.map(button => button.querySelector("svg")!.getBoundingClientRect().width),
          settingsGapToEdge: footerBox.right - settingsWell.right,
          sharedBottomBar: getComputedStyle(document.documentElement).getPropertyValue("--bottom-bar-h").trim(),
        };
      }, SIDEBAR_FOOTER);

      expect(layout.height).toBe(46);
      expect(layout.wells).toEqual([
        ["footer-theme", "footer-bug", "footer-whats-new", "footer-shortcuts", "open-activity"],
        ["footer-settings"],
      ]);
      expect(layout.wellHeights).toEqual([32, 32]);
      expect(new Set(layout.sizes)).toEqual(new Set(["32x26"]));
      expect(new Set(layout.iconSizes)).toEqual(new Set([16]));
      // 10px of padding, plus the sidebar's 1px right border.
      expect(layout.settingsGapToEdge).toBeLessThanOrEqual(11);
      // The other bottom bars (split strip, right-panel footer) keep theirs.
      expect(layout.sharedBottomBar).toBe("36px");
    });

    it("shows the unread dot while an older version is the last one seen", async () => {
      await writeLastSeen("0.0.1");
      await reloadApp();

      await waitVisible(DOT);
      const dot = await browser.execute(sel => {
        const box = document.querySelector(sel)!.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }, DOT);
      expect(dot).toEqual({ width: 6, height: 6 });

      await snap("footers-sidebar-unread.png");
    });

    it("clicking mail opens the Changelog with Contact and clears the dot", async () => {
      await clickWhenVisible(MAIL);

      await waitVisible(CONTACT);
      await waitGone(DOT);
      expect(await browser.execute(() => window.__termic!.useUI.getState().changelogOpen)).toBe(true);
      expect(await readLastSeen()).not.toBe("0.0.1");

      await browser.execute(() => window.__termic!.useUI.getState().closeChangelog());
      await waitGone(CONTACT);
    });

    it("keeps the dot gone after a reload", async () => {
      const seen = await readLastSeen();
      await reloadApp();

      await waitVisible(MAIL);
      expect(await browser.execute(sel => !!document.querySelector(sel), DOT)).toBe(false);
      expect(await readLastSeen()).toBe(seen);
    });

    it("the activity button still opens its own window", async () => {
      const mainHandle = await browser.getWindowHandle();
      const handlesBefore = await browser.getWindowHandles();

      await clickWhenVisible('[data-testid="open-activity"]');
      await browser.waitUntil(
        async () => (await browser.getWindowHandles()).length > handlesBefore.length,
        { timeout: 15_000, timeoutMsg: "Activity window never opened" },
      );

      const handlesAfter = await browser.getWindowHandles();
      const opened = handlesAfter.find(handle => !handlesBefore.includes(handle))!;
      await browser.switchToWindow(opened);
      await browser.closeWindow();
      await browser.switchToWindow(mainHandle);
    });
  });

  describe("task footer", () => {
    let taskId = "";

    before(async () => {
      taskId = await openTask("e2e-footers");
      await ensureActiveTask(taskId);
      await waitForAgentPty(taskId);
    });

    after(async () => {
      await browser.execute((id) => {
        const app = window.__termic!.useApp.getState();
        for (const tab of app.tabs[id] ?? []) {
          if (tab.type === "terminal") app.patchTab(id, tab.id, { queue: [] } as never);
        }
        if (app.terminalSplit[id]) app.toggleTerminalSplit(id);
      }, taskId);
      await archiveTask(taskId);
    });

    it("lines up with the sidebar footer as one 46px strip", async () => {
      await waitVisible(taskFooter(taskId));

      const strip = await browser.execute((sideSel, taskSel) => {
        const side = document.querySelector(sideSel)!.getBoundingClientRect();
        const task = document.querySelector(taskSel)!.getBoundingClientRect();
        const well = document.querySelector(`${taskSel} .footer-well`)!;
        return {
          sideHeight: side.height,
          taskHeight: task.height,
          bottomDelta: Math.abs(side.bottom - task.bottom),
          segments: [...well.querySelectorAll("button")].map(b => b.dataset.testid),
          rightmost: [...document.querySelector(taskSel)!.querySelectorAll("button")].pop()?.dataset.testid,
        };
      }, SIDEBAR_FOOTER, taskFooter(taskId));

      expect(strip.sideHeight).toBe(46);
      expect(strip.taskHeight).toBe(46);
      expect(strip.bottomDelta).toBeLessThan(1);
      expect(strip.segments).toEqual(["queue-button", "footer-terminal"]);
      expect(strip.rightmost).toBe("footer-sandbox");
    });

    it("raises the Queue segment and shows its count while messages are held", async () => {
      const queue = `${taskFooter(taskId)} [data-testid="queue-button"]`;
      expect(await browser.execute(sel => document.querySelector(sel)!.hasAttribute("data-active"), queue)).toBe(false);
      expect(await browser.execute(sel => !!document.querySelector(`${sel} [data-testid="queue-count"]`), queue)).toBe(false);

      // Scheduled a day out, so the fake agent never drains them mid-case.
      await browser.execute((id) => {
        const app = window.__termic!.useApp.getState();
        const tab = app.tabs[id].find((t: any) => t.type === "terminal")!;
        const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
        app.scheduleAgentMessage(id, tab.id, "footer-one", tomorrow);
        app.scheduleAgentMessage(id, tab.id, "footer-two", tomorrow);
      }, taskId);

      await waitForAttr(queue, "data-queued", "2");
      const seen = await browser.execute(sel => {
        const button = document.querySelector(sel) as HTMLElement;
        const count = button.querySelector('[data-testid="queue-count"]') as HTMLElement | null;
        const glyph = button.querySelector("svg")!;
        return {
          active: button.hasAttribute("data-active"),
          count: count?.innerText ?? null,
          countHeight: count?.getBoundingClientRect().height ?? 0,
          glyphColor: getComputedStyle(glyph).color,
          accent: getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim(),
        };
      }, queue);

      expect(seen.active).toBe(true);
      expect(seen.count).toBe("2");
      expect(seen.countHeight).toBe(16);
      // The active Queue glyph takes the accent, measured against the token.
      const accentProbe = await browser.execute((accent) => {
        const el = document.createElement("span");
        el.style.color = accent;
        document.body.appendChild(el);
        const resolved = getComputedStyle(el).color;
        el.remove();
        return resolved;
      }, seen.accent);
      expect(seen.glyphColor).toBe(accentProbe);

      await snap("footers-task-queued.png");
    });

    it("opens the bottom terminal from its segment and keeps one Queue control", async () => {
      const terminal = `${taskFooter(taskId)} [data-testid="footer-terminal"]`;
      expect(await browser.execute(sel => document.querySelector(sel)!.hasAttribute("data-active"), terminal)).toBe(false);

      await clickWhenVisible(terminal);
      await browser.waitUntil(
        () => browser.execute(id => !!window.__termic!.useApp.getState().terminalSplit[id], taskId),
        { timeout: 8_000, timeoutMsg: "the Terminal segment did not open the split" },
      );
      await browser.waitUntil(
        () => browser.execute(sel => document.querySelector(sel)!.hasAttribute("data-active"), terminal),
        { timeout: 8_000, timeoutMsg: "the Terminal segment did not rise with the split open" },
      );

      const queueButtons = await browser.execute(id =>
        document.querySelectorAll(`[data-task-id="${id}"] [data-testid="queue-button"]`).length, taskId);
      expect(queueButtons).toBe(1);

      await snap("footers-task-terminal-open.png");
    });

    it("draws plan usage as a meter per window, named in words", async () => {
      await ensureActiveTask(taskId);
      const agentId = await browser.execute(id =>
        window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)!.cli, taskId) as string;
      const report = (session: number) => browser.execute((agent, value) => {
        window.__termic!.useAgentUsage.getState().report(
          agent, null,
          { session: { usedPercent: value, resetsAt: null }, weekly: null, sessionCostUsd: null },
          "statusline");
      }, agentId, session);
      const readWindow = () => browser.execute(sel => {
        const win = document.querySelector(`${sel} [data-usage-window="5h"]`) as HTMLElement;
        const meter = win.querySelector(".footer-meter")!.getBoundingClientRect();
        const fill = win.querySelector(".footer-meter-fill") as HTMLElement;
        const label = win.querySelector(".footer-usage-label") as HTMLElement;
        return {
          level: win.dataset.level,
          label: label.innerText,
          labelColor: getComputedStyle(label).color,
          meterWidth: meter.width,
          fillWidth: fill.getBoundingClientRect().width,
          fillImage: getComputedStyle(fill).backgroundImage,
        };
      }, taskFooter(taskId));

      await report(42);
      await waitForAttr(`${taskFooter(taskId)} [data-usage-window="5h"]`, "data-usage-fill", "42");
      // The meter animates its width over 300ms.
      await browser.pause(400);
      const normal = await readWindow();
      expect(normal.level).toBe("normal");
      expect(normal.label).toBe("42% of 5h limit");
      expect(normal.meterWidth).toBe(64);
      expect(Math.abs(normal.fillWidth - 64 * 0.42)).toBeLessThan(1);
      expect(normal.fillImage).toContain("gradient");
      await snap("footers-usage-normal.png");

      await report(91);
      await waitForAttr(`${taskFooter(taskId)} [data-usage-window="5h"]`, "data-usage-fill", "91");
      await browser.pause(400);
      const high = await readWindow();
      const errInk = await browser.execute(() => {
        const el = document.createElement("span");
        el.style.color = "var(--color-err)";
        document.body.appendChild(el);
        const resolved = getComputedStyle(el).color;
        el.remove();
        return resolved;
      });
      expect(high.level).toBe("critical");
      expect(high.label).toBe("91% of 5h limit");
      expect(high.labelColor).toBe(errInk);
      expect(Math.abs(high.fillWidth - 64 * 0.91)).toBeLessThan(1);
      await snap("footers-usage-high.png");
    });

    it("names the sandbox state in its chip and opens the sandbox dialog", async () => {
      const chip = `${taskFooter(taskId)} [data-testid="footer-sandbox"]`;
      const seen = await browser.execute(sel => {
        const el = document.querySelector(sel) as HTMLElement;
        return {
          mode: el.dataset.sandboxMode,
          tone: el.dataset.tone ?? null,
          tag: (el.querySelector(".footer-tag") as HTMLElement).innerText,
          height: el.getBoundingClientRect().height,
        };
      }, chip);
      expect(seen).toEqual({ mode: "off", tone: null, tag: "OFF", height: 30 });

      await clickWhenVisible(chip);
      await browser.waitUntil(
        () => browser.execute(id => window.__termic!.useUI.getState().sandboxForTaskId === id, taskId),
        { timeout: 8_000, timeoutMsg: "the sandbox chip did not open the sandbox dialog" },
      );
      await browser.execute(() => window.__termic!.useUI.setState({ sandboxForTaskId: null } as never));
    });
  });
});