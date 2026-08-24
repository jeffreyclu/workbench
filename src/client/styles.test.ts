import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

describe('shared message layout', () => {
  it('caps conversation bubbles on every viewport and keeps them inside their thread', () => {
    const sharedMessageRule = styles.match(/\.shared-message\s*\{[^}]*\}/)?.[0] ?? '';

    expect(sharedMessageRule).toContain('width: min(94%, 640px)');
    expect(sharedMessageRule).toContain('min-width: 0');
    expect(sharedMessageRule).toContain('max-width: 100%');
    // The bubble is the clip boundary: no descendant may paint outside it.
    expect(sharedMessageRule).toContain('overflow: hidden');
  });

  it('stops agent response sections from being widened by their own content', () => {
    // These are grid containers/items, whose default min-width: auto lets one
    // unbreakable token or wide code block stretch the whole bubble open.
    for (const selector of ['.agent-response', '.agent-response-deck', '.agent-response-section', '.agent-markdown', '.message-markdown', '.live-run-output']) {
      // Anchored to the line start so a descendant rule such as
      // ".run-summary .agent-markdown" can't be mistaken for the base rule.
      const rule = styles.match(new RegExp(`^\\${selector}\\s*\\{[^}]*\\}`, 'm'))?.[0] ?? '';
      expect(rule, `${selector} rule exists`).not.toBe('');
      expect(rule, `${selector} declares min-width: 0`).toContain('min-width: 0');
    }
  });

  it('keeps streaming run output inside the bubble', () => {
    // A bare <pre> is white-space: pre with no overflow, so an unstyled live
    // run log stretches the bubble to the width of its longest tool line.
    const rule = styles.match(/\.live-run-output pre\s*\{[^}]*\}/)?.[0] ?? '';

    expect(rule).toContain('max-width: 100%');
    expect(rule).toContain('white-space: pre-wrap');
    expect(rule).toContain('overflow-wrap: anywhere');
  });
});

describe('conversation view controls', () => {
  it('keeps the Active and Archive switch above the expanding desktop navigation', () => {
    const viewTabsRule = styles.match(/\.conversation-view-tabs\s*\{[^}]*\}/)?.[0] ?? '';
    const desktopNavigationRule = styles.match(/\.sidebar\s*\{\s*position: fixed;[^}]*\}/)?.[0] ?? '';
    const viewTabsLayer = Number(viewTabsRule.match(/z-index:\s*(\d+)/)?.[1]);
    const desktopNavigationLayer = Number(desktopNavigationRule.match(/z-index:\s*(\d+)/)?.[1]);

    expect(viewTabsLayer).toBeGreaterThan(desktopNavigationLayer);
  });
});
