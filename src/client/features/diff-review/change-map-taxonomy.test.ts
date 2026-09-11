import { describe, expect, it } from 'vitest';
import type { ChangeMapSymbol } from '../../../shared/change-map.js';
import { categoryOf, folderLabel, folderOf, packageOf } from './change-map-taxonomy.js';

const value: ChangeMapSymbol = { name: 'render', kind: 'value', change: 'changed' };
const type: ChangeMapSymbol = { name: 'WorkspaceRef', kind: 'type', change: 'added' };

const kindOf = (filePath: string, symbols: ChangeMapSymbol[] = [value]) => categoryOf({ filePath, symbols });

describe('code categories', () => {
  it('reads the layer a file sits in from its path', () => {
    expect(kindOf('src/client/features/queue/view.tsx')).toBe('ui');
    expect(kindOf('src/client/hooks/use-diff.ts')).toBe('state');
    expect(kindOf('src/server/routes.ts')).toBe('api');
    expect(kindOf('src/server/repository.ts')).toBe('data');
    expect(kindOf('src/shared/contracts.ts')).toBe('types');
    expect(kindOf('src/shared/change-map.ts')).toBe('logic');
    expect(kindOf('src/client/app/styles.css')).toBe('styles');
    expect(kindOf('docs/shared-memory.md')).toBe('docs');
    expect(kindOf('package.json')).toBe('config');
    expect(kindOf('scripts/release.ts')).toBe('tooling');
    expect(kindOf('assets/logo.png')).toBe('other');
  });

  it('calls a test a test whatever layer it is testing', () => {
    // Otherwise a diff's tests scatter across every colour on the map and the
    // one thing they have in common — that they are tests — disappears.
    expect(kindOf('src/client/features/queue/view.test.tsx')).toBe('test');
    expect(kindOf('src/server/repository.test.ts')).toBe('test');
    expect(kindOf('src/server/__tests__/routes.ts')).toBe('test');
    expect(kindOf('src/server/repository.test.ts', [type])).toBe('test');
  });

  it('treats a change that moves nothing but types as a contract change', () => {
    expect(kindOf('src/server/routes.ts', [type])).toBe('types');
    expect(kindOf('src/server/routes.ts', [type, value])).toBe('api');
    expect(kindOf('src/server/routes.ts', [])).toBe('api');
  });
});

describe('packages and folders', () => {
  it('treats the top division under src as the package', () => {
    expect(packageOf('src/client/features/queue/view.tsx')).toBe('src/client');
    expect(packageOf('src/server/routes.ts')).toBe('src/server');
    expect(packageOf('src/shared/change-map.ts')).toBe('src/shared');
  });

  it('treats a workspace directory as the package', () => {
    expect(packageOf('packages/ui/src/button.tsx')).toBe('packages/ui');
    expect(packageOf('apps/web/app.tsx')).toBe('apps/web');
  });

  it('falls back to the top folder, and to the root for a loose file', () => {
    expect(packageOf('docs/plan.md')).toBe('docs');
    expect(packageOf('src/index.ts')).toBe('src');
    expect(packageOf('README.md')).toBe('.');
  });

  it('names a folder by what distinguishes it inside its package', () => {
    expect(folderOf('src/client/features/queue/view.tsx')).toBe('src/client/features/queue');
    expect(folderOf('README.md')).toBe('.');
    expect(folderLabel('src/client/features/queue', 'src/client')).toBe('features/queue');
    expect(folderLabel('src/server', 'src/server')).toBe('.');
  });
});
