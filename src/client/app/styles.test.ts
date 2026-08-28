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
  it('keeps an existing execution conversation openable while a task dispatch starts', () => {
    const rule = styles.match(/^\.detail-panel\.execution-starting button[^\{]*\{[^}]*\}/m)?.[0] ?? '';

    expect(rule).toContain('.open-run-chat');
    expect(rule).not.toContain('button:not(.mobile-detail-close)');
  });

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
    const phoneRules = styles.match(/@media \(max-width: 820px\) and \(pointer: coarse\) \{[\s\S]*?\.agent-console \.shared-thread \.jump-to-latest-button\s*\{[^}]*\}/)?.[0] ?? '';

    expect(phoneRules).toContain('.agent-console .shared-composer {\n    /* This is a flex item below the scrolling thread. Sticky positioning made');
    expect(phoneRules).toContain('position: relative; z-index: 2; flex: 0 0 auto;');
    expect(phoneRules).toContain('.agent-console .shared-thread .jump-to-latest-button');
    expect(phoneRules).toContain('position: sticky; bottom: 12px;');
  });

  it('uses one mobile conversation tray with details above a centered action row', () => {
    const phoneRules = styles;

    expect(phoneRules).toContain('.agent-console-header { position: absolute; inset: 0; z-index: 6; flex: 0 0 0; min-height: 0; height: 0; padding: 0; overflow: visible; border: 0; }');
    expect(phoneRules).toContain('.mobile-detail-close { position: fixed; top: 12px; right: 14px; z-index: 7; display: grid; place-items: center; width: 44px; height: 44px; padding: 0; color: #d9d8d0; background: #171715; border: 1px solid #373731; border-radius: 8px; box-shadow: 0 6px 16px #0009; }');
    expect(phoneRules).toContain('.agent-console-header.is-mobile-header-collapsed .conversation-window-actions { display: none; }');
    expect(phoneRules).toContain('.thread-filter-bar { display: none; }');
    expect(phoneRules).toContain('.agent-console-header:not(.is-mobile-header-collapsed) + .mobile-chrome-controls .mobile-conversation-toggle { display: none; }');
    expect(phoneRules).toContain('.agent-console-header:not(.is-mobile-header-collapsed) { position: fixed; inset: 0 0 auto; z-index: 6; height: 142px;');
    expect(phoneRules).toContain('.agent-console-header:not(.is-mobile-header-collapsed) .mobile-header-handle { position: fixed; bottom: calc(100dvh - 138px); left: 50%;');
    expect(phoneRules).toContain('.agent-console-title { position: fixed; top: 57px; right: 16px; left: 16px; z-index: 6; display: flex; align-items: center; justify-content: center; gap: 7px;');
    expect(phoneRules).toContain('.conversation-window-actions { position: fixed; top: 91px; right: 12px; left: 12px; z-index: 7;');
    expect(phoneRules).toContain('.mobile-review-toggle { position: fixed; top: 12px; left: 12px; z-index: 8; display: flex; align-items: center; padding: 0; background: transparent; border: 0;');
    expect(phoneRules).toContain('.agent-console-header.has-conversation-actions { min-height: 0; }');
    expect(phoneRules).toContain('.agent-console-header.has-conversation-actions .agent-console-title { max-width: none; padding-top: 0; }');
    expect(phoneRules).toContain('.agent-console-header h2 { flex: 1; width: auto; min-width: 0; margin: 0; overflow-x: auto; overflow-y: hidden; font-size: 18px; line-height: 1.15; text-overflow: clip; white-space: nowrap; -webkit-overflow-scrolling: touch; touch-action: pan-x; }');
  });

  it('keeps mobile actions usable while the review toggle is its own top-left block', () => {
    const rule = styles.match(/\.conversation-window-actions \{ position: fixed; top: 91px; right: 12px; left: 12px;[^}]*\}/)?.[0] ?? '';
    const reviewControl = styles.match(/\.mobile-review-toggle \{ position: fixed; top: 12px; left: 12px;[^}]*\}/)?.[0] ?? '';

    expect(rule).toContain('z-index: 7');
    expect(rule).toContain('flex-wrap: nowrap');
    expect(rule).toContain('justify-content: center');
    expect(rule).toContain('width: auto');
    expect(rule).toContain('max-width: none;');
    expect(rule).toContain('background: transparent');
    expect(styles).toContain('.conversation-window-actions .icon-button { flex: 0 0 auto; width: 36px; height: 36px; background: transparent; border-color: transparent;');
    expect(reviewControl).toContain('z-index: 8');
    expect(reviewControl).toContain('background: transparent');
    expect(reviewControl).toContain('box-shadow: none');
    expect(styles).toContain('.conversation-surface-tabs button { flex: 0 0 auto; justify-content: center; width: 44px; min-width: 44px; min-height: 44px; padding: 0; font-size: 0; }');
  });

  it('keeps Changes as the only review surface and gives it the composer on a phone', () => {
    expect(styles).not.toContain('layout-split');
    expect(styles).toContain('.conversation-review-layout.layout-changes { display: flex; flex-direction: column; }');
    expect(styles).toContain('.conversation-review-layout.layout-changes .conversation-thread-pane { display: contents; }');
    expect(styles).toContain('.conversation-review-layout.layout-changes .shared-thread { display: none; }');
    expect(styles).toContain('.conversation-changes { order: 1; flex: 1 1 auto; min-width: 0; min-height: 0;');
    expect(styles).not.toContain('.conversation-surface-tabs button:nth-child(2) { display: none; }');
  });

  it('collapses phone conversation metadata behind small toggle buttons while keeping actions available', () => {
    const phoneRules = styles.match(/@media \(max-width: 820px\) and \(pointer: coarse\) \{[\s\S]*?\.queued-message-action \{[^}]*\}/)?.[0] ?? '';

    expect(phoneRules).not.toContain('mobile-conversation-disclosure');
    expect(phoneRules).not.toContain('mobile-composer-disclosure');
    expect(phoneRules).toContain('.mobile-chrome-toggle { width: 44px; height: 44px; background: #171715; border-color: #373731; border-radius: 8px;');
    expect(phoneRules).toContain('.agent-console .shared-composer.is-mobile-composer-collapsed { display: none; }');
    expect(phoneRules).toContain('.mobile-composer-backdrop { position: fixed; inset: 0; z-index: 10;');
    expect(phoneRules).toContain('.agent-console .conversation-review-layout.layout-changes .shared-composer.mobile-composer-sheet,\n  .agent-console .shared-composer.mobile-composer-sheet {');
    expect(phoneRules).toContain('.agent-console .shared-composer.mobile-composer-sheet {');
    expect(phoneRules).toContain('.mobile-composer-handle { display: grid; place-items: center;');
    expect(phoneRules).toContain('.agent-console-header.is-mobile-header-collapsed { min-height: 0; padding: 0; border-bottom-color: transparent; }');
    expect(phoneRules).toContain('.agent-console-header.is-mobile-header-collapsed .agent-console-title { display: none; }');
    expect(phoneRules).toContain('.thread-filter-bar { display: none; }');
    expect(phoneRules).toContain('.mobile-detail-close { position: fixed; top: 12px; right: 14px; z-index: 7; display: grid; place-items: center; width: 44px; height: 44px; padding: 0; color: #d9d8d0; background: #171715; border: 1px solid #373731; border-radius: 8px; box-shadow: 0 6px 16px #0009; }');
    expect(phoneRules).toContain('.agent-console-header:not(.is-mobile-header-collapsed) .mobile-header-handle { position: fixed; bottom: calc(100dvh - 138px);');
    expect(phoneRules).toContain('.agent-console-title { position: fixed; top: 57px; right: 16px; left: 16px;');
    expect(phoneRules).toContain('.conversation-window-actions { position: fixed; top: 91px;');
    expect(phoneRules).toContain('.mobile-review-toggle { position: fixed; top: 12px; left: 12px; z-index: 8; display: flex; align-items: center; padding: 0;');
  });

  it('gives floating desktop review controls solid surfaces', () => {
    const barRule = styles.match(/^\.thread-filter-bar\s*\{[^}]*\}/m)?.[0] ?? '';
    const tabsRule = styles.match(/^\.conversation-surface-tabs\s*\{[^}]*\}/m)?.[0] ?? '';
    const pinRule = styles.match(/^\.thread-filter-bar > \.icon-button\s*\{[^}]*\}/m)?.[0] ?? '';

    expect(barRule).toContain('position: absolute');
    expect(barRule).toContain('z-index: 6');
    expect(tabsRule).toContain('border: 1px solid #373731');
    expect(tabsRule).toContain('background: #171715');
    expect(tabsRule).toContain('box-shadow: 0 6px 16px #0009');
    expect(pinRule).toContain('background: #171715');
    expect(pinRule).toContain('border-color: #373731');
    expect(pinRule).toContain('box-shadow: 0 6px 16px #0009');
  });

  it('reserves space for the expanded task-type control so it displaces the pin', () => {
    const popoverRule = styles.match(/^\.card-classification-popover\s*\{[^}]*\}/m)?.[0] ?? '';

    expect(popoverRule).toContain('display: inline-flex');
    expect(popoverRule).toContain('width: max-content');
    expect(popoverRule).not.toContain('position: absolute');
  });

  it('keeps the mobile composer action as a safe-area-aware bottom-right action', () => {
    const phoneRules = styles.match(/@media \(max-width: 820px\) and \(pointer: coarse\) \{[\s\S]*?\.queued-message-action \{[^}]*\}/)?.[0] ?? '';

    expect(phoneRules).toContain('.mobile-composer-toggle {\n    position: fixed; right: 14px;');
    expect(phoneRules).toContain('bottom: calc(var(--mobile-nav) + env(safe-area-inset-bottom, 0px) + 14px);');
    expect(phoneRules).not.toContain('.sidebar .mobile-conversation-nav,');
  });

  it('keeps the primary conversation destination in the mobile tab bar', () => {
    expect(styles).toMatch(/^\.mobile-chrome-controls, \.mobile-composer-toggle \{ display: none; \}/m);
    expect(styles).not.toContain('.sidebar .mobile-conversation-nav,');
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
    expect(styles).toContain('.workspace-diff nav > div, .github-diff nav > div { display: flex; max-height: 60px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; }');
    expect(styles).toContain('.workspace-diff nav button, .github-diff nav button { display: grid; flex: 0 0 clamp(260px, 20vw, 340px);');

    const phoneRules = styles.match(/@media \(max-width: 640px\) \{[\s\S]*?\.task-collapsible/)?.[0] ?? '';

    expect(phoneRules).toContain('.diff-file-list button { flex-basis: min(220px, 68vw); }');
    expect(styles).toContain('.diff-file-row > button { flex: 1 1 0; min-width: 0; }');
    expect(styles).toContain('.diff-file-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; padding: 7px 7px 7px 5px;');
    expect(styles).toContain('.diff-file-row > .diff-file-actions .diff-file-copy-path, .diff-file-row > .diff-file-actions .diff-file-open-editor { display: inline-flex; flex: 0 0 28px;');
    expect(styles).toContain('.workspace-diff-file { min-width: 0; overflow: hidden; }');
    expect(styles).toContain('.github-diff-file { min-width: 0; overflow: hidden; }');
    expect(styles).toContain('.workspace-diff-file pre { min-width: 0; max-width: 100%;');
    expect(styles).toContain('white-space: pre-wrap; overflow-wrap: anywhere;');
    expect(styles).toContain('.diff-line > span:last-child, .diff-line-code { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }');
    expect(phoneRules).toContain('.workspace-diff-file, .github-diff-file { min-width: 0; overflow: hidden; }');
  });

  it('clamps the recorded-version selector so it cannot dominate the phone action row', () => {
    const phoneRules = styles.match(/@media \(max-width: 640px\) \{[\s\S]*?\.task-collapsible/)?.[0] ?? '';

    expect(phoneRules).toContain('.workspace-diff-timeline { flex: 0 1 160px; max-width: 100%; }');
    expect(phoneRules).toContain('.workspace-diff-timeline select { width: 100%; }');
  });

  it('makes a pending diff assessment explicit instead of rendering an empty dark pill', () => {
    expect(styles).toContain('.diff-confidence-pending { min-width: 58px; color: #e6c75f; border-color: #8c6f2c; background: #2b2414; opacity: 1; }');
  });

  it('uses GitHub-dark addition and deletion colors without dimming inactive hunks', () => {
    expect(styles).toContain('.diff-line.addition { color: #aff5b4; background: #033a16; }');
    expect(styles).toContain('.diff-line.deletion { color: #ffdcd7; background: #67060c; }');
    const hunkRule = styles.match(/^\.diff-review-diff-block\s*\{[^}]*\}/m)?.[0] ?? '';

    expect(hunkRule).not.toContain('opacity');
    expect(styles).not.toContain('.diff-review-diff-block:hover { opacity: 1; }');
  });
});

describe('agent debugger layout', () => {
  it('uses connected tree rails with compact three-column event rows', () => {
    const layoutRule = styles.match(/^\.decision-tree-layout\s*\{[^}]*\}/m)?.[0] ?? '';
    const streamsRule = styles.match(/^\.decision-tree-streams\s*\{[^}]*\}/m)?.[0] ?? '';
    const phoneRules = styles.slice(styles.indexOf('@media (max-width: 700px)'));

    expect(layoutRule).not.toContain('grid-template-columns: minmax(0, 1fr) 260px');
    expect(streamsRule).toContain('border-left: 1px solid');
    expect(styles).toContain('.decision-tree-event-row');
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto');
    expect(styles).toContain('.decision-tree-details-pill');
    expect(styles).toContain('.decision-tree-tool-calls');
    expect(phoneRules).toContain('.decision-tree-event-row { grid-template-columns: minmax(0, 1fr) auto');
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
