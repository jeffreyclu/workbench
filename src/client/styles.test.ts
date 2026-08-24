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
  it('uses one desktop width and gutter for task and conversation stacks', () => {
    expect(styles).toContain('--stack-column-width: clamp(320px, 28vw, 380px)');
    expect(styles).toContain('grid-template-columns: 56px var(--stack-column-width) minmax(0, 1fr)');
    expect(styles).toContain('grid-template-columns: var(--stack-column-width) minmax(0, 1fr)');
    expect(styles).toContain('.queue-header { display: flex; justify-content: space-between; align-items: center; min-height: 66px; padding: 12px 15px;');
    expect(styles).toContain('.conversation-rail { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; padding: 18px 10px;');
  });

  it('gives expanded desktop navigation its own grid column instead of covering the switch', () => {
    expect(styles).toMatch(/\.app-shell:has\(\.sidebar:hover\),\s*\.app-shell:has\(\.sidebar:focus-within\)\s*\{\s*grid-template-columns:\s*220px/);
    const desktopNavigationRule = styles.match(/@media \(min-width: 821px\) \{[\s\S]*?\.sidebar\s*\{[^}]*\}/)?.[0] ?? '';

    expect(desktopNavigationRule).not.toContain('position: fixed');
  });
});

describe('interaction motion', () => {
  it('animates the requested interaction surfaces and honors reduced motion', () => {
    expect(styles).toContain('transition: grid-template-columns var(--motion-emphasized) var(--motion-ease)');
    expect(styles).toContain('.task-collapsible::details-content');
    expect(styles).toContain('animation: streaming-caret 900ms steps(2, end) infinite');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
