import { describe, expect, it } from 'vitest';
import { isTransportFailure, mapWithConcurrency } from '../../scripts/mcpjam-check.js';

describe('MCPJam bounded probe worker pool', () => {
  it('preserves matrix order while limiting active probes', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([30, 5, 20, 1, 10, 2], 3, async (delay, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return `probe-${index}`;
    });

    expect(peak).toBe(3);
    expect(results).toEqual(['probe-0', 'probe-1', 'probe-2', 'probe-3', 'probe-4', 'probe-5']);
  });

  it('never exceeds the number of available probes', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(['one', 'two'], 12, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    });

    expect(peak).toBe(2);
  });
});

describe('MCPJam probe transport classification', () => {
  it('treats an MCPJam connection timeout as a transport failure', () => {
    expect(isTransportFailure({
      error: { code: 'TIMEOUT', message: 'Failed to connect to MCP server "__cli__" using HTTP transports. Streamable HTTP error: Request timed out.' },
    })).toBe(true);
  });

  it('keeps tool results, including tool errors and successes, as contract results', () => {
    expect(isTransportFailure({
      content: [{ type: 'text', text: '{"error":{"code":"NOT_FOUND","message":"Work item not found."}}' }],
      structuredContent: { error: { code: 'NOT_FOUND', message: 'Work item not found.' } },
      isError: true,
    })).toBe(false);
    expect(isTransportFailure({ content: [{ type: 'text', text: '{}' }] })).toBe(false);
  });
});
