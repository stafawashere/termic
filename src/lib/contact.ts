// The two ways a user reaches us: email, and a prefilled GitHub issue.
// Shared by the sidebar footer (bug button) and the Changelog dialog
// (Contact), which is where the mailto moved when the footer's mail button
// became What's New.

import { openPath } from "@/lib/ipc";
import { copyToClipboard } from "@/lib/clipboard";

export const CONTACT_ADDRESS = "contact@termic.dev";

/** Hand a prefilled mailto: URL to the OS through `open_path`, the same Rust
 *  command the Open button uses for preview URLs (it shells out to macOS
 *  `open`, which handles mailto: too).
 *
 *  `open` exits 0 once it hands the URL to some app, even when that app can
 *  do nothing with it. The mailto: handler in LaunchServices is not tied to
 *  the "default email reader" setting and can point at a browser, which just
 *  opens a blank tab (#103). That failure is invisible from here, so the
 *  address is always copied as well. */
export function openMailto(to: string, subject: string, body: string) {
  const url = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  openPath(url).catch(() => {});
  copyToClipboard(to, to);
}

/** Open a prefilled "New issue" on the public GitHub tracker. */
export function openIssue(title: string, body: string) {
  const url = `https://github.com/simion/termic/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  openPath(url).catch(() => {});
}