import { useEffect, useRef } from 'react';

export const WORKBENCH_TITLE = 'Workbench';

function titleForAttentionCount(count: number): string {
  return count > 0 ? `(${count}) ${WORKBENCH_TITLE}` : WORKBENCH_TITLE;
}

function faviconForAttentionCount(count: number): string {
  const badge = count > 0 ? '<circle cx="25" cy="7" r="6" fill="#ef4444" stroke="#11110f" stroke-width="2"/>' : '';
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#c6f432"/><path d="M7 9h4l2 12 3-9h3l3 9 2-12h4l-4 15h-4l-2.5-7-2.5 7h-4z" fill="#0d0d0c"/>${badge}</svg>`)}`;
}

/** Reflects actionable agent work in browser chrome even while Workbench is backgrounded. */
export function useAttentionIndicator(attentionCount: number): void {
  const originalTitle = useRef(document.title);
  const originalFavicon = useRef(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? null);

  useEffect(() => {
    document.title = titleForAttentionCount(attentionCount);
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon) favicon.href = faviconForAttentionCount(attentionCount);
  }, [attentionCount]);

  useEffect(() => () => {
    document.title = originalTitle.current;
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon && originalFavicon.current) favicon.href = originalFavicon.current;
  }, []);
}
