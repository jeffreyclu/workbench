import { describe, expect, it } from 'vitest';
import { discoveryPriority } from './discovery.js';

describe('discovery relevance', () => {
  it('keeps direct code review requests and connector work', () => {
    expect(discoveryPriority({ provider: 'slack', title: 'Can you review my PR?', summary: 'Teammate requested a code review', url: 'https://writer.slack.com/archives/C/p1', occurredAt: null })).toBe(2);
    expect(discoveryPriority({ provider: 'github', title: 'Refactor query', summary: '', url: 'https://github.com/writer/repo/pull/42', occurredAt: null })).toBe(2);
    expect(discoveryPriority({ provider: 'linear', title: 'Fix connector permissions', summary: 'Connectors team', url: 'https://linear.app/writer/issue/CON-1', occurredAt: null })).toBe(2);
  });

  it('keeps other actionable work below focus items and drops passive noise', () => {
    expect(discoveryPriority({ provider: 'slack', title: 'Could you prepare the demo?', summary: 'Direct request', url: null, occurredAt: null })).toBe(1);
    expect(discoveryPriority({ provider: 'linear', title: 'Billing cleanup', summary: 'Payments team', url: null, occurredAt: null })).toBe(1);
    expect(discoveryPriority({ provider: 'slack', title: 'Weekly update', summary: 'Jeffrey was mentioned in an announcement', url: null, occurredAt: null })).toBe(0);
    expect(discoveryPriority({ provider: 'confluence', title: 'Benefits enrollment', summary: 'Annual policy update', url: null, occurredAt: null })).toBe(0);
  });
});
