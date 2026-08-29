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
      fileStatus: 'modified' as const,
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
    changeType: 'behavior_edit' as const, secondaryChangeTypes: [],
  riskSignals: [],
    state: null,
    note: null,
  };
}

/** A decision grouping hunks from several files, which is what the queue does
 * whenever one subject spans an implementation, its test and its fixtures. */
function groupedDecision(files: Array<{ filePath: string; lines: string[] }>, subject: string | null = null): ReviewDecision {
  const parts = files.map((file) => decision(file.filePath, file.lines, subject));
  return {
    ...parts[0],
    hunks: parts.flatMap((part) => part.hunks),
    filePaths: [...new Set(files.map((file) => file.filePath))],
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
    const unrelated = decision('src/client/unrelated.ts', ['+export const banner = 1;']);

    const map = buildChangeMap([producer, consumer, unrelated]);
    expect(map.nodes.find((node) => node.id === unrelated.id)?.degree).toBe(0);
    expect(map.nodes.find((node) => node.id === producer.id)?.degree).toBe(1);
    expect(map.omittedEdges).toBe(0);
  });

  it('maps only JS and TS sources', () => {
    const producer = decision('src/shared/loader.ts', ['+export function loadWorkspace() {}']);
    const styles = decision('src/client/styles.css', ['+.loadWorkspace { color: red; }']);
    const docs = decision('README.md', ['+Call loadWorkspace to start.']);

    const map = buildChangeMap([producer, styles, docs]);
    expect(map.nodes.map((node) => node.id)).toEqual([producer.id]);
    expect(map.edges).toHaveLength(0);
  });

  it('never makes a test the source of an edge', () => {
    // The regression: `describe('loadWorkspace')` gave the test a subject, the
    // subject counted as a declaration, and every implementation mentioning
    // `loadWorkspace` became downstream of the test.
    const test = decision('src/shared/loader.test.ts', [
      "+describe('loadWorkspace', () => {",
      '+  expect(loadWorkspace()).toBe(1);',
    ], 'loadWorkspace');
    const implementation = decision('src/shared/loader.ts', ['+export function loadWorkspace() {}']);
    const caller = decision('src/client/caller.ts', ['+  loadWorkspace();']);

    const map = buildChangeMap([test, implementation, caller]);
    expect(map.edges.filter((edge) => edge.fromId === test.id)).toHaveLength(0);
    expect(relationBetween([test, implementation, caller], implementation.id, test.id)).toBe('calls');
    expect(relationBetween([test, implementation, caller], implementation.id, caller.id)).toBe('calls');
  });

  it('ignores a declaration nested inside a function body', () => {
    // A local is invisible to any other decision, so sharing its name is a
    // coincidence rather than a relationship.
    const producer = decision('src/shared/loader.ts', ['+  const workspaceRows = readRows();']);
    const consumer = decision('src/client/caller.ts', ['+  render(workspaceRows);']);

    expect(relationBetween([producer, consumer], producer.id, consumer.id)).toBeNull();
  });

  it('uses the subject as the declared symbol for a body-only edit', () => {
    // A hunk inside an unchanged function declares nothing on its own lines;
    // the enclosing subject is what the rest of the diff reacts to.
    const producer = decision('src/shared/loader.ts', ['+  cache.clear();'], 'loadWorkspace');
    const consumer = decision('src/client/caller.ts', ['+  loadWorkspace();']);

    expect(relationBetween([producer, consumer], producer.id, consumer.id)).toBe('calls');
  });

  it('declares nothing from the test half of a decision that spans code and its test', () => {
    // The queue groups by subject, so an implementation and its test are one
    // decision and `isTestDecision` never fired on it. A fixture declared at
    // the top of the test then owned its name for the whole diff.
    const mixed = groupedDecision([
      { filePath: 'src/shared/loader.ts', lines: ['+export function loadWorkspace() {}'] },
      { filePath: 'src/shared/loader.test.ts', lines: ['+const fixtureRows = buildRows();'] },
    ], 'loadWorkspace');
    const consumer = decision('src/client/panel.ts', ['+  render(fixtureRows);']);
    const caller = decision('src/client/caller.ts', ['+  loadWorkspace();']);

    const decisions = [mixed, consumer, caller];
    expect(relationBetween(decisions, mixed.id, consumer.id)).toBeNull();
    // The implementation half is unaffected: it still sources its own edges.
    expect(relationBetween(decisions, mixed.id, caller.id)).toBe('calls');
  });

  it('reads no identifiers from a non-JS hunk inside a code decision', () => {
    // `isCodeDecision` passes as soon as one file is code, so prose in the same
    // decision used to name a changed symbol and draw an edge for it.
    const producer = decision('src/shared/loader.ts', ['+export function loadWorkspace() {}']);
    const mixed = groupedDecision([
      { filePath: 'docs/notes.md', lines: ['+Call loadWorkspace once the pane mounts.'] },
      { filePath: 'src/client/panel.ts', lines: ['+const paneReady = true;'] },
    ]);

    expect(relationBetween([producer, mixed], producer.id, mixed.id)).toBeNull();
  });

  it('locates a decision at its implementation file, not at whichever file came first', () => {
    const mixed = groupedDecision([
      { filePath: 'src/shared/loader.test.ts', lines: ['+  expect(loadWorkspace()).toBe(1);'] },
      { filePath: 'src/shared/loader.ts', lines: ['+export function loadWorkspace() {}'] },
    ], 'loadWorkspace');

    expect(buildChangeMap([mixed]).nodes[0]?.filePath).toBe('src/shared/loader.ts');
  });
});

describe('syntax-aware reading of a hunk', () => {
  it('ignores a name that only appears in a string or a comment', () => {
    // The scanner this replaced read diff lines as text, so a symbol named in
    // prose or in a log message linked two unrelated changes.
    const producer = decision('src/shared/loader.ts', ['+export function loadWorkspace() {}']);
    const consumer = decision('src/client/caller.ts', [
      '+  // loadWorkspace is documented here, not called.',
      "+  logger.info('loadWorkspace finished');",
    ]);

    expect(relationBetween([producer, consumer], producer.id, consumer.id)).toBeNull();
  });

  it('reads a parameter added to a signature that wraps across several lines', () => {
    const producer = decision('src/shared/loader.ts', [
      '-export function loadWorkspace(',
      '-  id: string,',
      '-) {',
      '+export function loadWorkspace(',
      '+  id: string,',
      '+  workspacePath: string,',
      '+) {',
    ]);
    const consumer = decision('src/client/caller.ts', ['+  const loaded = loadWorkspace(id, workspacePath);']);

    const edge = buildChangeMap([producer, consumer]).edges.find((candidate) => candidate.toId === consumer.id);
    expect(edge?.relation).toBe('passes-parameter');
    expect(edge?.explanation).toContain('workspacePath');
  });

  it('links a changed component to the JSX that renders it', () => {
    const producer = decision('src/client/button.tsx', ['+export function SubmitButton() {', '+  return <button />;', '+}']);
    const consumer = decision('src/client/form.tsx', ['+  return <SubmitButton />;']);

    expect(relationBetween([producer, consumer], producer.id, consumer.id)).toBe('calls');
  });

  it('links a new prop to the JSX that passes it', () => {
    // A React component takes its props as one destructured parameter, so a new
    // prop is a widened signature and the call site is the element that renders it.
    const producer = decision('src/client/button.tsx', [
      '-export function SubmitButton({ label }: Props) {',
      '+export function SubmitButton({ label, variant }: Props) {',
    ]);
    const consumer = decision('src/client/form.tsx', ['+  return <SubmitButton label="Go" variant="primary" />;']);

    const edge = buildChangeMap([producer, consumer]).edges.find((candidate) => candidate.toId === consumer.id);
    expect(edge?.relation).toBe('passes-parameter');
    expect(edge?.explanation).toContain('variant');
  });

  it('does not treat a declaration nested inside a function as something the diff can see', () => {
    const producer = decision('src/shared/loader.ts', ['+  const workspaceCache = new Map();']);
    const consumer = decision('src/client/caller.ts', ['+  workspaceCache.clear();']);

    expect(relationBetween([producer, consumer], producer.id, consumer.id)).toBeNull();
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
