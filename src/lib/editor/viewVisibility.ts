export type ObserveVisibility = (element: HTMLElement, onChange: (isVisible: boolean) => void) => () => void;

/** Reports whether an element is on screen. A display:none tab or pane never
 *  intersects, so no polling is needed. Without IntersectionObserver the
 *  element counts as visible. The first answer is a synchronous probe, because
 *  the observer's first callback can land after a zero-delay timer. */
export const observeElementVisibility: ObserveVisibility = (element, onChange) => {
  const hasObserver = typeof IntersectionObserver !== "undefined";
  if (!hasObserver) {
    onChange(true);
    return () => {};
  }

  const canProbe = typeof element.checkVisibility === "function";
  onChange(canProbe ? element.checkVisibility() : true);

  const observer = new IntersectionObserver(entries => {
    const latest = entries[entries.length - 1];
    if (latest) onChange(latest.isIntersecting);
  });
  observer.observe(element);

  return () => observer.disconnect();
};
