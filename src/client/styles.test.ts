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
