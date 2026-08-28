import { describe, expect, it } from 'vitest';
import { buildChangeMap, resolveModulePath, type ChangeRelation } from './change-map.js';
import type { ReviewDecision } from './review-decisions.js';

let sequence = 0;

/** A decision carrying one hunk of literal patch lines. The analyzer only ever
 * reads `hunks[].lines`, `filePaths`, `subject` and the identity fields, so a
 * fixture stays honest while omitting the queue's presentation counters. */
function decision(filePath: string, lines: string[], subject: string | null = null): ReviewDecision {
  sequence += 1;
  const id = `decision-${sequence}`;
  return {
    id,
    ordinal: sequence,
    subject,
    behavior: `Change in ${filePath}`,
    hunks: [{
      id: `${id}-hunk`,
      filePath,
      editorUrl: null,
      hunkRange: '@@ -1,1 +1,1 @@',
      location: filePath,
      lines,
      additions: lines.filter((line) => line.startsWith('+')).length,
      deletions: lines.filter((line) => line.startsWith('-')).length,
      state: null,
      note: null,
    }],
    filePaths: [filePath],
    additions: lines.filter((line) => line.startsWith('+')).length,
    deletions: lines.filter((line) => line.startsWith('-')).length,
    riskSignals: [],
    state: null,
    note: null,
  };
}

function relationBetween(decisions: ReviewDecision[], fromId: string, toId: string): ChangeRelation | null {
  const edge = buildChangeMap(decisions).edges.find((candidate) => candidate.fromId === fromId && candidate.toId === toId);
  return edge?.relation ?? null;
}

describe('diff-scoped change map', () => {
  it('links a widened signature to the call sites that pass the new parameter', () => {
    const producer = decision('src/shared/loader.ts', [
      '-export function loadWorkspace(id: string) {',
      '+export function loadWorkspace(id: string, workspacePath: string) {',
    ]);
    const consumer = decision('src/client/caller.ts', [
      '+  const loaded = loadWorkspace(id, workspacePath);',
    ]);

    const map = buildChangeMap([producer, consumer]);
    const edge = map.edges.find((candidate) => candidate.toId === consumer.id);
    expect(edge?.relation).toBe('passes-parameter');
    expect(edge?.fromId).toBe(producer.id);
    expect(edge?.explanation).toContain('workspacePath');
  });

  it('treats a brand-new function as a plain call rather than a widened signature', () => {
    // No removed counterpart means nobody was calling it before, so there is no
    // parameter to have been added to an existing caller.
    const producer = decision('src/shared/loader.ts', ['+export function loadWorkspace(id: string, workspacePath: string) {']);
    const consumer = decision('src/client/caller.ts', ['+  const loaded = loadWorkspace(id, workspacePath);']);

    expect(relationBetween([producer, consumer], producer.id, consumer.id)).toBe('calls');
  });

  it('links a changed type to the decisions that reference it', () => {
    const producer = decision('src/shared/types.ts', [
      '-export interface WorkspaceRef { id: string }',
      '+export interface WorkspaceRef { id: string; workspacePath: string }',
    ]);
    const consumer = decision('src/client/panel.ts', ['+function render(reference: WorkspaceRef) {']);

    expect(relationBetween([producer, consumer], producer.id, consumer.id)).toBe('references-type');
  });

  it('keeps the strongest relation when two changes relate in several ways', () => {
    // The consumer both calls the symbol and passes its new parameter; only the
    // parameter fact tells the reviewer why this hunk had to move.
    const producer = decision('src/shared/loader.ts', [
      '-export function loadWorkspace(id: string) {',
      '+export function loadWorkspace(id: string, workspacePath: string) {',
    ]);
    const consumer = decision('src/client/caller.ts', [
      '+  loadWorkspace(id, workspacePath);',
      '+  return loadWorkspace;',
    ]);

    expect(buildChangeMap([producer, consumer]).edges).toHaveLength(1);
    expect(relationBetween([producer, consumer], producer.id, consumer.id)).toBe('passes-parameter');
  });

  it('draws no edge to a symbol that is not itself changed in the diff', () => {
    // `existingHelper` is declared somewhere in the repository, but not in this
    // diff, so nothing about it moved and there is no relationship to show.
    const first = decision('src/client/one.ts', ['+  existingHelper(alpha);']);
    const second = decision('src/client/two.ts', ['+  existingHelper(beta);']);

    expect(buildChangeMap([first, second]).edges).toHaveLength(0);
  });

  it('ignores names too common to be a relationship', () => {
    const producer = decision('src/client/one.ts', ['+const value = compute();']);
    const consumer = decision('src/client/two.ts', ['+  record(value);']);

    expect(buildChangeMap([producer, consumer]).edges).toHaveLength(0);
  });

  it('ignores a name declared by so many decisions that it is a collision', () => {
    const declarations = ['a', 'b', 'c', 'd'].map((suffix) => decision(`src/client/${suffix}.ts`, [`+function renderPanel() { return ${suffix}; }`]));
    const consumer = decision('src/client/consumer.ts', ['+  renderPanel();']);

    expect(buildChangeMap([...declarations, consumer]).edges).toHaveLength(0);
  });

  it('links an import to the changed module it resolves to', () => {
    const producer = decision('src/shared/loader.ts', ['+export function loadWorkspace() {}']);
    const consumer = decision('src/client/caller.ts', ["+import { loadWorkspace } from '../shared/loader.js';"]);

    expect(relationBetween([producer, consumer], producer.id, consumer.id)).toBe('imports');
  });

  it('counts degree so unrelated changes are identifiable', () => {
    const producer = decision('src/shared/loader.ts', ['+export function loadWorkspace() {}']);
    const consumer = decision('src/client/caller.ts', ['+  loadWorkspace();']);
    const unrelated = decision('README.md', ['+Documentation only.']);

    const map = buildChangeMap([producer, consumer, unrelated]);
    expect(map.nodes.find((node) => node.id === unrelated.id)?.degree).toBe(0);
    expect(map.nodes.find((node) => node.id === producer.id)?.degree).toBe(1);
    expect(map.omittedEdges).toBe(0);
  });

  it('uses the subject as the declared symbol for a body-only edit', () => {
    // A hunk inside an unchanged function declares nothing on its own lines;
    // the enclosing subject is what the rest of the diff reacts to.
    const producer = decision('src/shared/loader.ts', ['+  cache.clear();'], 'loadWorkspace');
    const consumer = decision('src/client/caller.ts', ['+  loadWorkspace();']);

    expect(relationBetween([producer, consumer], producer.id, consumer.id)).toBe('calls');
  });
});

describe('module specifier resolution', () => {
  it('resolves a relative specifier against the importing file and drops extensions', () => {
    expect(resolveModulePath('src/client/caller.ts', '../shared/loader.js')).toBe('src/shared/loader');
    expect(resolveModulePath('src/client/caller.ts', './sibling.js')).toBe('src/client/sibling');
  });

  it('returns null for a bare package specifier, which is never in the diff', () => {
    expect(resolveModulePath('src/client/caller.ts', 'react')).toBeNull();
  });
});
