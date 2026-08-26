import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

describe('shared message layout', () => {
  it('caps conversation bubbles on every viewport and keeps them inside their thread', () => {
    const sharedMessageRule = styles.match(/^\.shared-message\s*\{[^}]*\}/m)?.[0] ?? '';

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

  it('keeps the live activity feed inside the bubble', () => {
    const rule = styles.match(/^\.live-run-output li\s*\{[^}]*\}/m)?.[0] ?? '';

    expect(rule).toContain('overflow-wrap: anywhere');
    expect(rule).toContain('word-break: break-word');
  });

  it('stacks completed interjection segments vertically instead of shrinking them into columns', () => {
    const rowRule = styles.match(/^\.thread-segmented-message\s*\{[^}]*\}/m)?.[0] ?? '';
    const segmentRule = styles.match(/^\.shared-message-segment-group\s*\{[^}]*\}/m)?.[0] ?? '';

    expect(rowRule).toContain('flex-direction: column');
    expect(segmentRule).toContain('flex-direction: column');
    expect(segmentRule).toContain('width: 100%');
    expect(segmentRule).toContain('min-width: 0');
  });
});

describe('conversation view controls', () => {
  it('keeps queued agent actions icon-only and does not add them to queued system promotions', () => {
    const systemQueuedRule = styles.match(/\.shared-message\.shared-system-queued\s*\{[^}]*\}/)?.[0] ?? '';
    const queuedActionRule = styles.match(/\.queued-message-action\s*\{[^}]*\}/)?.[0] ?? '';

    expect(systemQueuedRule).toContain('width: min(94%, 520px)');
    expect(queuedActionRule).toContain('width: 28px');
    expect(queuedActionRule).toContain('height: 28px');
    expect(styles).not.toContain('min-height: 44px; padding: 2px 12px');
  });

  it('pins the running-response cancel X to the bubble top-right', () => {
    const rule = styles.match(/\.shared-message \.cancel-response\s*\{[^}]*\}/)?.[0] ?? '';

    expect(rule).toContain('position: absolute');
    expect(rule).toContain('top: 8px');
    expect(rule).toContain('right: 8px');
  });

  it('uses one desktop width and gutter for task and conversation stacks', () => {
    expect(styles).toContain('--stack-column-width: clamp(320px, 28vw, 380px)');
    expect(styles).toContain('grid-template-columns: 56px var(--stack-column-width) minmax(0, 1fr)');
    expect(styles).toContain('grid-template-columns: var(--stack-column-width) minmax(0, 1fr)');
    expect(styles).toContain('.queue-header { display: flex; justify-content: space-between; align-items: center; min-height: 66px; padding: 12px 15px;');
    expect(styles).toContain('.conversation-rail { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; padding: 18px 10px;');
  });

  it('keeps both conversation panes as shrinking, independently scrollable flex regions', () => {
    expect(styles).toContain('.conversation-tab-panel { display: flex; flex: 1; min-height: 0; }');
    expect(styles).toContain('.conversation-tabs { position: relative; z-index: 0; flex: 1; min-height: 0; overflow: auto; }');
    expect(styles).toContain('.shared-thread { display: block; flex: 1; min-height: 0; overflow: auto;');
  });

  it('gives expanded desktop navigation its own grid column instead of covering the switch', () => {
    expect(styles).toMatch(/\.app-shell:has\(\.sidebar:hover\),\s*\.app-shell:has\(\.sidebar:focus-within\)\s*\{\s*grid-template-columns:\s*220px/);
    const desktopNavigationRule = styles.match(/@media \(min-width: 821px\) \{[\s\S]*?\.sidebar\s*\{[^}]*\}/)?.[0] ?? '';

    expect(desktopNavigationRule).not.toContain('position: fixed');
  });

  it('keeps the phone composer in normal flex flow and the jump control above it', () => {
    const phoneRules = styles.match(/@media \(max-width: 820px\) \{[\s\S]*?\.agent-console \.shared-thread \.jump-to-latest-button\s*\{[^}]*\}/)?.[0] ?? '';

    expect(phoneRules).toContain('.agent-console .shared-composer {\n    /* This is a flex item below the scrolling thread. Sticky positioning made');
    expect(phoneRules).toContain('position: relative; z-index: 2; flex: 0 0 auto;');
    expect(phoneRules).toContain('.agent-console .shared-thread .jump-to-latest-button');
    expect(phoneRules).toContain('position: sticky; bottom: 12px;');
  });

  it('keeps the mobile conversation title to one line clear of the close control', () => {
    const phoneRules = styles.match(/@media \(max-width: 820px\) \{[\s\S]*?\.conversation-window-actions \{[^}]*\}/)?.[0] ?? '';

    expect(phoneRules).toContain('.agent-console-header .mobile-detail-close { position: absolute; top: 12px; right: 14px; }');
    expect(phoneRules).toContain('.agent-console-title { flex: 1 1 100%; min-width: 0; max-width: calc(100% - 44px); }');
    expect(phoneRules).toContain('.agent-console-header h2 { width: 100%; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }');
  });

  it('wraps mobile task-linked conversation controls into extra rows like the task header, instead of an overflow menu', () => {
    const rule = styles.match(/@media \(max-width: 820px\) \{[\s\S]*?\.conversation-window-actions \{[^}]*\}/)?.[0].match(/\.conversation-window-actions \{[^}]*\}/)?.[0] ?? '';

    expect(rule).toContain('flex-wrap: wrap');
    expect(rule).not.toContain('overflow-x: auto');
    expect(styles).toContain('.conversation-window-actions .icon-button { flex: 0 0 auto; width: 44px; height: 44px; }');
  });
});

describe('phone dialogs', () => {
  it('bounds the new-task dialog to the visual viewport and makes its content scrollable', () => {
    const dialogRule = styles.match(/^\.dialog\s*\{[^}]*\}/m)?.[0] ?? '';
    const phoneRules = styles.slice(styles.lastIndexOf('@media (max-width: 640px)'));

    expect(dialogRule).toContain('max-height: calc(100dvh - 48px)');
    expect(dialogRule).toContain('overflow-y: auto');
    expect(dialogRule).toContain('-webkit-overflow-scrolling: touch');
    expect(phoneRules).toContain('.dialog-backdrop { align-items: start; overflow-y: auto; padding: 12px; }');
    expect(phoneRules).toContain('.dialog { max-height: calc(100dvh - 24px); margin-block: 0; }');
    expect(phoneRules).toContain('.add-task-dialog { min-height: 0; }');
  });
});

describe('diff review layout', () => {
  it('gives both local and GitHub diffs a compact file rail and a full-width patch pane on every viewport', () => {
    expect(styles).toContain('.workspace-diff-layout, .github-diff-layout { display: grid; grid-template-columns: minmax(0, 1fr);');
    expect(styles).toContain('.workspace-diff nav > div, .github-diff nav > div { display: flex; max-height: 68px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; }');
    expect(styles).toContain('.workspace-diff nav button, .github-diff nav button { display: grid; flex: 0 0 min(280px, 40vw);');

    const phoneRules = styles.match(/@media \(max-width: 640px\) \{[\s\S]*?\.task-collapsible/)?.[0] ?? '';

    expect(phoneRules).toContain('.diff-file-list button { flex-basis: min(220px, 68vw); }');
    expect(phoneRules).toContain('.workspace-diff-file, .github-diff-file { min-width: 0; overflow-x: auto; overscroll-behavior-x: contain; }');
  });

  it('clamps the recorded-version selector so it cannot dominate the phone action row', () => {
    const phoneRules = styles.match(/@media \(max-width: 640px\) \{[\s\S]*?\.task-collapsible/)?.[0] ?? '';

    expect(phoneRules).toContain('.workspace-diff-timeline { flex: 0 1 160px; max-width: 100%; }');
    expect(phoneRules).toContain('.workspace-diff-timeline select { width: 100%; }');
  });

  it('makes a pending diff assessment explicit instead of rendering an empty dark pill', () => {
    expect(styles).toContain('.diff-confidence-pending { min-width: 58px; color: #e6c75f; border-color: #8c6f2c; background: #2b2414; opacity: 1; }');
  });
});

describe('agent debugger layout', () => {
  it('uses connected tree rails with a full-width mobile layout', () => {
    const layoutRule = styles.match(/^\.decision-tree-layout\s*\{[^}]*\}/m)?.[0] ?? '';
    const streamsRule = styles.match(/^\.decision-tree-streams\s*\{[^}]*\}/m)?.[0] ?? '';
    const phoneRules = styles.slice(styles.indexOf('@media (max-width: 700px)'));

    expect(layoutRule).toContain('grid-template-columns: minmax(0, 1fr) 260px');
    expect(streamsRule).toContain('border-left: 1px solid');
    expect(styles).toContain('.decision-tree-inspectable-card');
    expect(styles).toContain('.decision-tree-tool-calls');
    expect(phoneRules).toContain('grid-template-columns: 1fr');
    expect(phoneRules).toContain('position: static');
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
