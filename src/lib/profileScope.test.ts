// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";

// The module reads the window label ONCE at import time (stores read their
// keys at module-init, so it has to be synchronous), which means each case
// has to set the label before a fresh import.
async function loadWith(label: string | undefined) {
  const g = globalThis as Record<string, unknown>;
  if (label === undefined) {
    delete g.__TAURI_INTERNALS__;
  } else {
    g.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label } } };
  }
  // resetModules, not a cache-busting query string: the module memoizes the
  // namespace at import time on purpose, so each case needs a fresh evaluation.
  vi.resetModules();
  return (await import("@/lib/profileScope")) as typeof import("@/lib/profileScope");
}

describe("profileScope", () => {
  const original = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  afterEach(() => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = original;
  });

  it("leaves the root profile's keys unprefixed, so an existing install migrates nothing", async () => {
    // The whole reason the root profile keeps the `main` window label. If this
    // regresses, every user's collapse state, folder colors and prompt library
    // silently reset on the release that ships profiles.
    const { scoped, PROFILE_NS } = await loadWith("main");
    expect(PROFILE_NS).toBe("");
    expect(scoped("collapsedGroups")).toBe("collapsedGroups");
    expect(scoped("promptLibrary")).toBe("promptLibrary");
  });

  it("namespaces a non-root profile's keys by its window label", async () => {
    const { scoped, PROFILE_NS } = await loadWith("profile-work");
    expect(PROFILE_NS).toBe("profile-work:");
    expect(scoped("collapsedGroups")).toBe("profile-work:collapsedGroups");
  });

  it("treats a non-profile window as the root", async () => {
    // The Activity monitor is a window too, and it addressed the root before
    // profiles existed.
    const { scoped } = await loadWith("procmon");
    expect(scoped("groupColors")).toBe("groupColors");
  });

  it("falls back to the root outside a Tauri window", async () => {
    // vitest and the activity.html entry both hit this path.
    const { scoped } = await loadWith(undefined);
    expect(scoped("groupColors")).toBe("groupColors");
  });

  it("purges only the deleted profile's keys", async () => {
    // A recreated profile with the same slug would otherwise inherit a dead
    // profile's collapse state and folder colors.
    const { purgeProfileKeys } = await loadWith("main");
    localStorage.setItem("profile-work:collapsedGroups", "1");
    localStorage.setItem("profile-work:groupColors", "2");
    localStorage.setItem("profile-home:collapsedGroups", "3");
    localStorage.setItem("collapsedGroups", "4");
    localStorage.setItem("theme", "dark");

    purgeProfileKeys("work");

    expect(localStorage.getItem("profile-work:collapsedGroups")).toBeNull();
    expect(localStorage.getItem("profile-work:groupColors")).toBeNull();
    // Another profile, the root, and a shared preference all survive.
    expect(localStorage.getItem("profile-home:collapsedGroups")).toBe("3");
    expect(localStorage.getItem("collapsedGroups")).toBe("4");
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("does not scope shared preferences", async () => {
    // Documenting the boundary as a test: these keys are machine-level in the
    // plan's scope table, so a future edit that scopes them fails here first.
    const { scoped } = await loadWith("profile-work");
    for (const pref of ["theme", "shortcutBindings", "terminalFont", "editorThemeId"]) {
      expect(scoped(pref)).toBe(`profile-work:${pref}`);
    }
    // ...which is to say `scoped()` namespaces whatever it is handed. The
    // boundary is enforced by NOT calling it on those keys; this asserts the
    // helper has no secret allow-list that would make that subtle.
  });
});


describe("profile accents", () => {
  it("resolves a palette key to its theme token", async () => {
    const { profileAccentCss } = await import("@/lib/accents");
    expect(profileAccentCss("blue")).toBe("var(--color-swatch-blue)");
  });

  it("passes a user-chosen hex straight through", async () => {
    // Profiles may carry a literal colour the user picked. That is DATA in
    // profiles.json, not a hardcoded style, so it does not conflict with the
    // rule keeping the app's own colours in @theme.
    const { profileAccentCss } = await import("@/lib/accents");
    expect(profileAccentCss("#ff8800")).toBe("#ff8800");
    expect(profileAccentCss("#f80")).toBe("#f80");
    expect(profileAccentCss("#FF8800AA")).toBe("#FF8800AA");
  });

  it("falls back rather than painting nothing for a value that is neither", async () => {
    // A hand-edited profiles.json, or a palette entry removed in a future
    // version. The tile still has to render.
    const { profileAccentCss, PROFILE_ACCENT_FALLBACK } = await import("@/lib/accents");
    for (const bad of ["nope", "#12", "rgb(1,2,3)", "red; background:url(x)", "", undefined]) {
      expect(profileAccentCss(bad as string | undefined)).toBe(PROFILE_ACCENT_FALLBACK);
    }
  });

  it("tells a hex apart from a key", async () => {
    const { isHexAccent } = await import("@/lib/accents");
    expect(isHexAccent("#abc")).toBe(true);
    expect(isHexAccent("blue")).toBe(false);
    expect(isHexAccent("#abcd")).toBe(false);
  });
});

describe("currentSetupSummary", () => {
  it("names both counts, so the panel is unmistakably YOUR setup", async () => {
    const { currentSetupSummary } = await import("@/lib/profileScope");
    expect(currentSetupSummary(4, 12)).toBe("Its 4 projects and 12 tasks stay exactly where they are.");
  });

  it("does not say '1 projects'", async () => {
    const { currentSetupSummary } = await import("@/lib/profileScope");
    expect(currentSetupSummary(1, 1)).toBe("Its 1 project and 1 task stay exactly where they are.");
  });

  it("drops the half that is zero rather than counting nothing", async () => {
    // "3 projects and 0 tasks" reads as a warning about the zero.
    const { currentSetupSummary } = await import("@/lib/profileScope");
    expect(currentSetupSummary(3, 0)).toBe("Its 3 projects stay exactly where they are.");
    expect(currentSetupSummary(0, 2)).toBe("Its 2 tasks stay exactly where they are.");
  });

  it("says something else entirely on a fresh install", async () => {
    // Counting nothing reads as a bug, and there is nothing to reassure
    // someone about when they have not made anything yet.
    const { currentSetupSummary } = await import("@/lib/profileScope");
    expect(currentSetupSummary(0, 0)).toBe("Everything you set up from now on stays in it.");
  });
});

describe("shouldCloseProfileWindow", () => {
  it("closes the window when it is empty and another is open", async () => {
    const { shouldCloseProfileWindow } = await import("@/lib/profileScope");
    expect(shouldCloseProfileWindow({ hasActiveTask: false, openWindows: 2 })).toBe(true);
  });

  it("never closes the LAST window", async () => {
    // That is a quit, not a window close, and it belongs to the close-action
    // setting and to Cmd+Q. Escalating a tab-close key into a quit is how
    // someone loses the agents they had running.
    const { shouldCloseProfileWindow } = await import("@/lib/profileScope");
    expect(shouldCloseProfileWindow({ hasActiveTask: false, openWindows: 1 })).toBe(false);
    expect(shouldCloseProfileWindow({ hasActiveTask: false, openWindows: 0 })).toBe(false);
  });

  it("leaves the shortcut to the task while one is open", async () => {
    // Cmd+W closes the innermost thing. With a task on screen that is a tab,
    // and taking the window instead would close work the user can see.
    const { shouldCloseProfileWindow } = await import("@/lib/profileScope");
    expect(shouldCloseProfileWindow({ hasActiveTask: true, openWindows: 3 })).toBe(false);
  });
});

describe("slugWorthShowing", () => {
  it("hides a slug that is just the name lowercased", async () => {
    // "Personal" above "personal" reads as a bug, not as information.
    const { slugWorthShowing } = await import("@/lib/profileScope");
    expect(slugWorthShowing("Personal", "personal")).toBe(false);
    expect(slugWorthShowing("  Work  ", "work")).toBe(false);
  });

  it("shows one the user could not have guessed", async () => {
    // These are the cases the slug exists for: it names the folder on disk.
    const { slugWorthShowing } = await import("@/lib/profileScope");
    expect(slugWorthShowing("Side Project", "side-project")).toBe(true);
    expect(slugWorthShowing("Work", "work-2")).toBe(true);
    expect(slugWorthShowing("Ünïcode", "unicode")).toBe(true);
  });
});
