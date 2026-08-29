import { describe, expect, it } from 'vitest';
import { symbolsAtRisk } from './stale-references.js';

const file = (patch: string, path = 'src/config.ts') => ({ path, patch, isBinary: false });

describe('symbolsAtRisk', () => {
  it('takes declarations the patch changed, which are the ones callers can be stale about', () => {
    expect(symbolsAtRisk([file([
      '-export function loadConfig(path) {',
      '+export function loadConfig(path, mode) {',
    ].join('\n'))])).toEqual(['loadConfig']);
  });

  it('takes a declaration the patch deleted outright', () => {
    expect(symbolsAtRisk([file('-export function legacyLoader() {}')])).toEqual(['legacyLoader']);
  });

  it('ignores a purely new declaration, which nothing outside can reference yet', () => {
    expect(symbolsAtRisk([file('+export function brandNewThing() {}')])).toEqual([]);
  });

  it('drops names too common for a repository-wide grep to mean anything', () => {
    expect(symbolsAtRisk([file([
      '-export function handler() {}',
      '-export function loadConfig() {}',
    ].join('\n'))])).toEqual(['loadConfig']);
  });

  it('skips binary files and files with no patch', () => {
    expect(symbolsAtRisk([
      { path: 'image.png', patch: null, isBinary: true },
      { path: 'notes.md', patch: '-export function loadConfig() {}', isBinary: false },
    ])).toEqual([]);
  });
});
