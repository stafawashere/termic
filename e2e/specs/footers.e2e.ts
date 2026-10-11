// The footer strip (docs/ui.md "The footer strip"): the sidebar's bar and
// the task's bar, one 46px strip across the window.
//
// Sidebar half: its wells, button order and sizes, the What's New unread dot
// on the mail button, the Contact control in the Changelog dialog, and the
// activity button. The unread state comes from the update store's
// localStorage watermark, so the spec seeds an old seen version and reloads.
// The running version is the e2e build's real one, always newer than 0.0.1.

import {
  clickWhenVisible,
  dismissOverlays,
  requireTermicApi,
  snap,
  waitForAppShell,
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
});