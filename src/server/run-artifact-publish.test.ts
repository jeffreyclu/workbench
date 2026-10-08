import { describe, expect, it, vi } from 'vitest';
import { collectRunMarkdownPaths, publishRunMarkdown } from './run-artifact-publish.js';
import type { ObservedRunEvent } from './review-handoff.js';

const write = (detail: string): ObservedRunEvent => ({ category: 'agent_file_write', streamKind: 'file_write', detail });
const ws = '/tmp/wt';
const docsRoot = '/tmp/wbdocs';

describe('run markdown auto-publish', () => {
  it('collects docs/ and Workbench documents markdown only', () => {
    const events = [
      write('/tmp/wt/docs/foo.md'), write('update: docs/bar.md'), write('[sub] /tmp/wbdocs/notes/n.md'),
      write('/tmp/wt/README.md'), write('/tmp/wt/docs/a.ts'), write('/tmp/wt/docs/node_modules/x/readme.md'),
      write('/tmp/wt/docs/fixtures/f.md'), write('delete: docs/gone.md'), write('/tmp/wt/docs/foo.md'),
    ];
    expect(collectRunMarkdownPaths(events, [ws], docsRoot)).toEqual(['/tmp/wt/docs/foo.md', '/tmp/wt/docs/bar.md', '/tmp/wbdocs/notes/n.md']);
  });

  it('publishes nothing for a run that wrote no markdown', async () => {
    const publish = vi.fn();
    expect(await publishRunMarkdown({ events: [write('/tmp/wt/src/a.ts')], workspaces: [ws], workItemId: 'w', conversationId: null }, vi.fn(), publish, docsRoot)).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('records activity only for new versions and survives failures', async () => {
    const activity = vi.fn();
    const publish = vi.fn()
      .mockResolvedValueOnce({ published: true })
      .mockResolvedValueOnce({ published: false })
      .mockRejectedValueOnce(new Error('deploy down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await publishRunMarkdown({ events: [write('/tmp/wt/docs/a.md'), write('/tmp/wt/docs/b.md'), write('/tmp/wt/docs/c.md')], workspaces: [ws], workItemId: 'w', conversationId: 'c' }, activity, publish, docsRoot);
    expect(result).toEqual(['/tmp/wt/docs/a.md']);
    expect(activity).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({ path: '/tmp/wt/docs/a.md', workItemId: 'w', conversationId: 'c' });
  });
});
