import { describe, expect, it } from 'vitest';
import { reviewDispatchLabel } from '../shared/review-dispatch.js';
import { classifyReviewDispatch } from './review-dispatch.js';

const file = (path: string, added: number | null = 5, removed: number | null = 1) => ({ path, added, removed });

describe('classifyReviewDispatch', () => {
  it('never reviews a docs-only change', () => {
    expect(classifyReviewDispatch([file('README.md', 40, 2), file('docs/setup.md', 12, 0)])).toEqual({
      mode: 'never', tier: 'trivial', reason: 'it is a docs-only change (README.md, docs/setup.md)',
      files: ['README.md', 'docs/setup.md'], changedLines: 54,
    });
  });

  it('never reviews a one-line config change', () => {
    expect(classifyReviewDispatch([file('vite.config.ts', 1, 1)])).toEqual(expect.objectContaining({
      mode: 'never', tier: 'trivial', reason: 'it is a single-file change of 2 lines (vite.config.ts)', changedLines: 2,
    }));
  });

  it('always reviews a six-file feature at the standard tier', () => {
    const decision = classifyReviewDispatch([
      'src/server/feature.ts', 'src/server/feature.test.ts', 'src/client/features/feature/view.tsx',
      'src/client/features/feature/view.test.tsx', 'src/client/lib/feature-format.ts', 'src/client/app/styles.css',
    ].map((path) => file(path)));
    expect(decision).toEqual(expect.objectContaining({ mode: 'always', tier: 'standard', reason: 'it is a multi-file change (6 files)', changedLines: 36 }));
  });

  it('always reviews a migration at the sensitive tier, even as a one-line change', () => {
    expect(classifyReviewDispatch([file('db/migrations/0042_add_index.sql', 1, 0)])).toEqual(expect.objectContaining({
      mode: 'always', tier: 'sensitive', reason: 'it touches data (db/migrations/0042_add_index.sql); migrations (db/migrations/0042_add_index.sql)',
    }));
  });

  it('marks src/server/database.ts as sensitive data', () => {
    const decision = classifyReviewDispatch([file('src/server/database.ts', 12, 0)])!;
    expect(decision).toEqual(expect.objectContaining({ mode: 'always', tier: 'sensitive', reason: 'it touches data (src/server/database.ts)' }));
    expect(reviewDispatchLabel(decision)).toBe('review: always / sensitive, because it touches data (src/server/database.ts)');
  });

  it('treats auth, authorization, and secrets as sensitive', () => {
    expect(classifyReviewDispatch([file('src/server/auth/session.ts')])?.tier).toBe('sensitive');
    expect(classifyReviewDispatch([file('src/server/external-action-authorization.ts')])?.reason).toBe('it touches authorization (src/server/external-action-authorization.ts)');
    expect(classifyReviewDispatch([file('.env.local', 1, 0)])?.reason).toBe('it touches secrets (.env.local)');
  });

  it('always reviews a small change to a shared component or public API', () => {
    expect(classifyReviewDispatch([file('src/shared/contracts.ts', 1, 0)])).toEqual(expect.objectContaining({
      mode: 'always', tier: 'standard', reason: 'it touches a shared component or public API (src/shared/contracts.ts)',
    }));
  });

  it('leaves a larger isolated single-file change to judgment, with the reason', () => {
    expect(classifyReviewDispatch([file('src/server/scheduler.ts', 20, 4)])).toEqual(expect.objectContaining({
      mode: 'judgment', tier: 'standard', reason: 'it is a single-file change of 24 lines (src/server/scheduler.ts), at or over the 10-line limit',
    }));
    expect(classifyReviewDispatch([file('src/server/scheduler.ts', null, null)])).toEqual(expect.objectContaining({
      mode: 'judgment', changedLines: null, reason: 'it is a single-file change whose line count is unavailable (src/server/scheduler.ts)',
    }));
  });

  it('decides nothing when nothing changed', () => {
    expect(classifyReviewDispatch([])).toBeNull();
  });
});
