import { useEffect, useRef } from 'react';
import { sendDesktopNotification } from './desktop-notifications';

export const WORKBENCH_TITLE = 'Workbench';

function titleForAttentionCount(count: number): string {
  return count > 0 ? `(${count}) ${WORKBENCH_TITLE}` : WORKBENCH_TITLE;
}

function faviconForAttentionCount(count: number): string {
  const badge = count > 0 ? '<circle cx="25" cy="7" r="6" fill="#ef4444" stroke="#11110f" stroke-width="2"/>' : '';
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#c6f432"/><path d="M7 9h4l2 12 3-9h3l3 9 2-12h4l-4 15h-4l-2.5-7-2.5 7h-4z" fill="#0d0d0c"/>${badge}</svg>`)}`;
}

/**
 * f56784d8-3aa2-4786-a93f-9c3cc437d20f LEGACY-AFFECTING: Existing callers
 * keep their tab-title and favicon badge. New actionable work now also uses
 * the already opted-in desktop notification path when this window lacks focus.
 */
/** Reflects actionable agent work in browser chrome even while Workbench is backgrounded. */
export function useAttentionIndicator(attentionCount: number): void {
  const originalTitle = useRef(document.title);
  const originalFavicon = useRef(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? null);
  const previousAttentionCount = useRef(attentionCount);

  useEffect(() => {
    document.title = titleForAttentionCount(attentionCount);
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon) favicon.href = faviconForAttentionCount(attentionCount);
  }, [attentionCount]);

  useEffect(() => {
    const addedAttention = attentionCount > previousAttentionCount.current;
    previousAttentionCount.current = attentionCount;
    if (!addedAttention || document.hasFocus()) return;
    sendDesktopNotification({
      title: 'Workbench needs attention',
      body: `${attentionCount} agent ${attentionCount === 1 ? 'run is' : 'runs are'} ready for you.`,
    });
  }, [attentionCount]);

  useEffect(() => () => {
    document.title = originalTitle.current;
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon && originalFavicon.current) favicon.href = originalFavicon.current;
  }, []);
}
