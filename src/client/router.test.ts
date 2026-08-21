// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { navigate, parseRoute, routePath, useRoute, type Route } from './router';

afterEach(() => { window.history.replaceState(null, '', '/'); });

describe('parseRoute', () => {
  it('maps every destination to a readable address', () => {
    expect(parseRoute('/')).toEqual({ name: 'stack', stack: 'active' });
    expect(parseRoute('/workbench')).toEqual({ name: 'stack', stack: 'workbench' });
    expect(parseRoute('/archive')).toEqual({ name: 'stack', stack: 'archive' });
    expect(parseRoute('/tasks/abc-123')).toEqual({ name: 'task', taskId: 'abc-123' });
    expect(parseRoute('/conversations')).toEqual({ name: 'conversations', conversationId: null });
    expect(parseRoute('/conversations/abc-123')).toEqual({ name: 'conversations', conversationId: 'abc-123' });
    expect(parseRoute('/discovery')).toEqual({ name: 'discovery' });
    expect(parseRoute('/artifacts')).toEqual({ name: 'artifacts' });
    expect(parseRoute('/insights')).toEqual({ name: 'insights' });
  });

  it('falls back to the attention stack for addresses it does not know', () => {
    expect(parseRoute('/nope')).toEqual({ name: 'stack', stack: 'active' });
    expect(parseRoute('/tasks')).toEqual({ name: 'stack', stack: 'active' });
  });

  it('tolerates trailing slashes and encoded identifiers', () => {
    expect(parseRoute('/workbench/')).toEqual({ name: 'stack', stack: 'workbench' });
    expect(parseRoute('/tasks/a%20b')).toEqual({ name: 'task', taskId: 'a b' });
  });

  it('round-trips every route back to itself', () => {
    const routes: Route[] = [
      { name: 'stack', stack: 'active' },
      { name: 'stack', stack: 'workbench' },
      { name: 'stack', stack: 'archive' },
      { name: 'task', taskId: 'abc-123' },
      { name: 'conversations', conversationId: null },
      { name: 'conversations', conversationId: 'abc-123' },
      { name: 'discovery' },
      { name: 'artifacts' },
      { name: 'insights' },
    ];
    for (const route of routes) expect(parseRoute(routePath(route))).toEqual(route);
  });
});

describe('useRoute', () => {
  it('reads the address the page was opened on', () => {
    window.history.replaceState(null, '', '/tasks/abc-123');
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: 'task', taskId: 'abc-123' });
  });

  it('rewrites an unknown address to the destination it actually shows', () => {
    window.history.replaceState(null, '', '/not-a-place');
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: 'stack', stack: 'active' });
    expect(window.location.pathname).toBe('/');
  });

  it('follows navigation and back again', async () => {
    const { result } = renderHook(() => useRoute());
    act(() => navigate({ name: 'stack', stack: 'workbench' }));
    expect(window.location.pathname).toBe('/workbench');
    expect(result.current).toEqual({ name: 'stack', stack: 'workbench' });

    act(() => navigate({ name: 'task', taskId: 'abc-123' }));
    expect(result.current).toEqual({ name: 'task', taskId: 'abc-123' });

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    });
    expect(window.location.pathname).toBe('/workbench');
    expect(result.current).toEqual({ name: 'stack', stack: 'workbench' });
  });

  it('does not stack up history entries for the destination already open', () => {
    const { result } = renderHook(() => useRoute());
    act(() => navigate({ name: 'insights' }));
    act(() => navigate({ name: 'insights' }));
    expect(result.current).toEqual({ name: 'insights' });
    // One press of back has to leave Insights, not repeat it.
    expect(window.location.pathname).toBe('/insights');
  });

  it('replaces the current entry when asked', async () => {
    const { result } = renderHook(() => useRoute());
    act(() => navigate({ name: 'stack', stack: 'archive' }));
    act(() => navigate({ name: 'task', taskId: 'abc-123' }, { replace: true }));
    expect(result.current).toEqual({ name: 'task', taskId: 'abc-123' });

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    });
    expect(window.location.pathname).toBe('/');
  });
});
