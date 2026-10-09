// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSnapshot } from '../../../shared/contracts';
import { useSessionTerminal } from './terminal-hooks';

afterEach(() => vi.unstubAllGlobals());

const mirrored = (texts: string[]): TerminalSnapshot => ({
  session: { state: 'none', pid: null, model: null, providerSessionId: 'sess-1', stopReason: null },
  lines: texts.map((text, offset) => ({ offset, at: '2026-10-09T00:00:00Z', kind: 'host' as const, text })),
  nextOffset: texts.length,
  mirror: { provider: 'claude', sessionId: 'sess-1' },
});

describe('useSessionTerminal', () => {
  it('replaces its lines with the mirrored activity and refetches when realtime invalidates the stream events', async () => {
    let current = mirrored(['> one']);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(current), { headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSessionTerminal('c1', 'claude', true), { wrapper });

    await waitFor(() => expect(result.current.mirror).toEqual({ provider: 'claude', sessionId: 'sess-1' }));
    await waitFor(() => expect(result.current.lines.map((line) => line.text)).toEqual(['> one']));

    // The same invalidation realtime.ts sends for a conversation's message events.
    current = mirrored(['> one', '● Read: a.ts']);
    await act(async () => { await client.invalidateQueries({ queryKey: ['shared-agent-events', 'c1'] }); });
    await waitFor(() => expect(result.current.lines.map((line) => line.text)).toEqual(['> one', '● Read: a.ts']));
  });
});
