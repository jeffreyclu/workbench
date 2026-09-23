/**
 * Moves keyboard focus to an element that is not natively focusable (a heading,
 * a status region) so screen reader users land on the result of an async action
 * instead of losing their place when the triggering control disappears from the DOM.
 * Mirrors the WAI-ARIA APG pattern of shifting focus to a heading after a view update.
 */
export function focusElement(element: HTMLElement | null): void {
  if (!element) return;
  if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
  element.focus({ preventScroll: false });
}
