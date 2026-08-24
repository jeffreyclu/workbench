import { expect, test } from '@playwright/test';

// Jeffrey's standing rule for the phone conversation view: a message bubble and
// everything painted inside it must stay within the screen. Anything that makes
// the thread scroll sideways is the bug, whether it is the bubble box itself or
// an unbreakable token, code block, table, or streaming run output inside it.
//
// Content that lives in its own horizontal scroll container (a code block, a
// wide table) is exempt: it scrolls inside the bubble, which is the intended
// treatment. What is never allowed is that content widening the bubble.
const LONG_TOKEN = 'a'.repeat(220);
const LONG_URL = `https://internal.example.com/very/deep/path/${'segment-'.repeat(30)}end?token=${LONG_TOKEN}`;
const WIDE_CODE_LINE = `const value = ${'"chunk-of-code-that-never-wraps" + '.repeat(20)}"end";`;
const WIDE_TABLE = [
  `| ${Array.from({ length: 12 }, (_, index) => `column-header-${index}`).join(' | ')} |`,
  `| ${Array.from({ length: 12 }, () => '---').join(' | ')} |`,
  `| ${Array.from({ length: 12 }, (_, index) => `a-fairly-long-cell-${index}`).join(' | ')} |`,
].join('\n');

const SEEDED = [
  { author: 'jeffrey', status: 'completed', body: `Plain unbroken token: ${LONG_TOKEN}` },
  { author: 'jeffrey', status: 'completed', body: `A bare url that must not push the bubble out: ${LONG_URL}` },
  {
    author: 'jeffrey',
    status: 'completed',
    body: `Inline code token: \`${LONG_TOKEN}\` and a path /Users/jeffrey.lu/dev/workbench/${'nested/'.repeat(25)}file.ts`,
  },
  { author: 'jeffrey', status: 'completed', body: ['Fenced block:', '```ts', WIDE_CODE_LINE, WIDE_CODE_LINE, '```'].join('\n') },
  { author: 'jeffrey', status: 'completed', body: WIDE_TABLE },
  {
    // A structured agent report: sections, a wide code block, a wide table and
    // an unbreakable token, all nested inside the agent-response grid.
    author: 'claude',
    status: 'completed',
    body: [
      '## Facts',
      `Traced it to /Users/jeffrey.lu/dev/workbench/${'deeply/'.repeat(25)}module.ts and ${LONG_URL}`,
      '',
      '## Evidence',
      '```ts',
      WIDE_CODE_LINE,
      '```',
      '',
      WIDE_TABLE,
      '',
      '## Decisions',
      `Token: ${LONG_TOKEN}`,
    ].join('\n'),
  },
  {
    // Mid-run streaming output: the raw tool log, which is the widest thing the
    // conversation view ever renders.
    author: 'codex',
    status: 'running',
    body: [
      `$ rg --line-number "${LONG_TOKEN}" /Users/jeffrey.lu/dev/workbench/${'nested/'.repeat(20)}src`,
      WIDE_CODE_LINE,
      `${'stdout-column '.repeat(40)}done`,
    ].join('\n'),
  },
] as const;

test.describe('phone conversation bubbles', () => {
  test('no bubble or its content can exceed the width of the screen', async ({ page }) => {
    const created = await page.request.post('/api/shared/conversations', { data: { title: 'Bubble width probe' } });
    expect(created.ok()).toBeTruthy();
    const { conversation } = await created.json();

    for (const seed of SEEDED) {
      const posted = await page.request.post('/api/e2e/seed-message', { data: { conversationId: conversation.id, ...seed } });
      expect(posted.ok(), `seeding ${seed.author} message: ${seed.body.slice(0, 40)}`).toBeTruthy();
    }

    await page.goto(`/conversations/${conversation.id}`);
    await expect(page.locator('.shared-message').first()).toBeVisible();
    // The thread is virtualized, so the agent bubbles at the end only exist in
    // the DOM once they are scrolled into the window.
    await page.locator('.shared-thread').evaluate((thread) => thread.scrollTo(0, thread.scrollHeight));
    await expect(page.locator('.agent-response')).toBeVisible();
    await expect(page.locator('.live-run-output, .agent-markdown').first()).toBeVisible();

    const viewportWidth = page.viewportSize()!.width;

    const measurement = await page.evaluate(() => {
      const offenders: { where: string; scrollWidth: number; clientWidth: number; right: number }[] = [];
      const scrolls = (element: Element) => {
        const overflowX = getComputedStyle(element).overflowX;
        return overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden';
      };
      document.querySelectorAll('.shared-message').forEach((bubble, index) => {
        const box = bubble.getBoundingClientRect();
        offenders.push({ where: `.shared-message[${index}]`, scrollWidth: bubble.scrollWidth, clientWidth: bubble.clientWidth, right: box.right });
        bubble.querySelectorAll('*').forEach((node) => {
          const nodeBox = node.getBoundingClientRect();
          if (nodeBox.width === 0 || nodeBox.right <= box.right + 1) return;
          // Skip anything already clipped by its own scroll container.
          for (let ancestor = node.parentElement; ancestor && ancestor !== bubble; ancestor = ancestor.parentElement) {
            if (scrolls(ancestor)) return;
          }
          const className = typeof node.className === 'string' && node.className ? `.${node.className.trim().split(/\s+/).join('.')}` : '';
          offenders.push({ where: `.shared-message[${index}] ${node.tagName.toLowerCase()}${className}`, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, right: nodeBox.right });
        });
      });
      const thread = document.querySelector('.shared-thread')!;
      return {
        offenders,
        documentScrollWidth: document.documentElement.scrollWidth,
        threadScrollWidth: thread.scrollWidth,
        threadClientWidth: thread.clientWidth,
      };
    });

    const report = JSON.stringify(measurement.offenders, null, 2);
    const escapees = measurement.offenders.filter((entry) => entry.right > viewportWidth + 1);

    expect(escapees, `content painted past the ${viewportWidth}px screen\n${report}`).toEqual([]);
    expect(measurement.documentScrollWidth, `document scrolls sideways\n${report}`).toBeLessThanOrEqual(viewportWidth);
    expect(measurement.threadScrollWidth, `the thread scrolls sideways\n${report}`).toBeLessThanOrEqual(measurement.threadClientWidth);
  });
});
