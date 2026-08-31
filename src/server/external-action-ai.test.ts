import { afterEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { classifyExternalActionWithHaiku, shutdownExternalActionClassifier } from './external-action-ai.js';
import { fakeAgentDirectory } from './test-fake-agent.js';

const originalPath = process.env.PATH;
let temporaryDirectory: string | null = null;

afterEach(() => {
  shutdownExternalActionClassifier();
  process.env.PATH = originalPath;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
});

it('starts each authorization timeout when that queued judgment begins executing', async () => {
  const denied = JSON.stringify({ type: 'result', result: JSON.stringify({ granted: false, operation: null }) });
  const granted = JSON.stringify({ type: 'result', result: JSON.stringify({ granted: true, operation: 'Create the Linear card.' }) });
  const fixture = fakeAgentDirectory('exit 1', [
    'IFS= read -r first',
    '/bin/sleep 0.5',
    `printf '%s\\n' '${denied}'`,
    'IFS= read -r second',
    '/bin/sleep 0.5',
    `printf '%s\\n' '${granted}'`,
  ].join('\n'));
  temporaryDirectory = fixture.directory;

  const [first, second] = await Promise.all([
    classifyExternalActionWithHaiku('first judgment', 800),
    classifyExternalActionWithHaiku('second judgment', 800),
  ]);

  expect(first).toContain('"granted":false');
  expect(second).toContain('"granted":true');
});
