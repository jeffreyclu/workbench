import { useEffect, useMemo, useSyncExternalStore } from 'react';

/**
 * Workbench renders as one page, but every destination Jeffrey returns to — a
 * task, a conversation, a library — has to survive a reload, a link pasted into
 * Slack, and the browser's own back and forward buttons. The URL is therefore
 * the source of truth for navigation state; components read it with useRoute()
 * and change it with navigate() instead of holding their own view state.
 */
export type StackName = 'active' | 'workbench' | 'archive';

export type Route =
  | { name: 'stack'; stack: StackName }
  | { name: 'task'; taskId: string }
  | { name: 'conversations'; conversationId: string | null }
  | { name: 'discovery' }
  | { name: 'artifacts' }
  | { name: 'insights' };

const stackPaths: Record<StackName, string> = { active: '/', workbench: '/workbench', archive: '/archive' };
const libraryRoutes = ['discovery', 'artifacts', 'insights'] as const;

/**
 * A task keeps one URL wherever it lives, so a link stays good after the task
 * moves between the attention stack, the workbench, and the archive. The stack
 * behind an open task is resolved from the task itself, not from its address.
 */
export function parseRoute(pathname: string): Route {
  const [first, second] = pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (first === 'workbench' || first === 'archive') return { name: 'stack', stack: first };
  if (first === 'tasks' && second) return { name: 'task', taskId: second };
  if (first === 'conversations') return { name: 'conversations', conversationId: second ?? null };
  const library = libraryRoutes.find((route) => route === first);
  if (library) return { name: library };
  return { name: 'stack', stack: 'active' };
}

export function routePath(route: Route): string {
  if (route.name === 'stack') return stackPaths[route.stack];
  if (route.name === 'task') return `/tasks/${encodeURIComponent(route.taskId)}`;
  if (route.name === 'conversations') return route.conversationId ? `/conversations/${encodeURIComponent(route.conversationId)}` : '/conversations';
  return `/${route.name}`;
}

export function routesMatch(left: Route, right: Route): boolean {
  return routePath(left) === routePath(right);
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Back and forward are browser-driven, so the store has to listen for them as
// well as for the pushes this module makes itself.
if (typeof window !== 'undefined') window.addEventListener('popstate', notify);

function currentPath(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname;
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const path = routePath(route);
  // Re-selecting the destination you are already on must not stack up history
  // entries that turn one back press into several.
  if (path === currentPath()) return;
  if (options.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  notify();
}

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, currentPath, () => '/');
  const route = useMemo(() => parseRoute(path), [path]);
  useEffect(() => {
    // An unknown or non-canonical address still renders something sensible;
    // rewriting it keeps the visible URL honest about what is on screen.
    const canonical = routePath(route);
    if (canonical !== window.location.pathname) window.history.replaceState(null, '', canonical);
  }, [route]);
  return route;
}
