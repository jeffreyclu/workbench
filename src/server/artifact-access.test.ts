import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactRoots, isArtifactAllowed } from './artifact-access.js';

describe('artifact access', () => {
  it('allows sibling repositories under the development root', () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-artifacts-'));
    const workbench = join(root, 'workbench');
    const otherRepo = join(root, 'writer-monorepo');
    mkdirSync(workbench);
    mkdirSync(otherRepo);
    const artifact = join(otherRepo, 'proposal.md');
    writeFileSync(artifact, 'proposal');

    expect(isArtifactAllowed(artifact, workbench, workbench, '')).toBe(true);
    expect(artifactRoots(workbench, workbench, '')).toContain(realpathSync(root));
  });

  it('blocks files outside development and configured roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-artifacts-'));
    const dev = join(root, 'dev');
    const workbench = join(dev, 'workbench');
    mkdirSync(workbench, { recursive: true });
    const secret = join(root, 'secret.txt');
    writeFileSync(secret, 'secret');

    expect(isArtifactAllowed(secret, workbench, workbench, '')).toBe(false);
  });

  it('allows an explicitly configured additional root', () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-artifacts-'));
    const workbench = join(root, 'dev/workbench');
    const notes = join(root, 'notes');
    mkdirSync(workbench, { recursive: true });
    mkdirSync(notes);
    const artifact = join(notes, 'brief.md');
    writeFileSync(artifact, 'brief');

    expect(isArtifactAllowed(artifact, workbench, workbench, notes)).toBe(true);
  });
});
