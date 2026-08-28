import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./view.tsx', import.meta.url)), 'utf8');

describe('TaskDetail workspace review', () => {
  it('keeps workspace review collapsed until the reviewer explicitly opens it', () => {
    expect(source).toContain('<details className="detail-section task-collapsible workspace-review-section">');
    expect(source).toContain('<summary><span>Workspace review</span><small>Latest changes and recorded snapshots</small></summary>');
    expect(source).not.toContain('<details className="detail-section task-collapsible workspace-review-section" open>');
  });
});
