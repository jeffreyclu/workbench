import { afterEach, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { EXTERNAL_ACTION_CLASSIFIER_PROMPT, classifyExternalActionWithHaiku, shutdownExternalActionClassifier } from './external-action-ai.js';
import { fakeAgentDirectory } from './test-fake-agent.js';

const originalPath = process.env.PATH;
let temporaryDirectory: string | null = null;

afterEach(() => {
  shutdownExternalActionClassifier();
  process.env.PATH = originalPath;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
});

it('classifies simultaneous messages in isolated single-use workers', async () => {
  const denied = JSON.stringify({ type: 'result', result: JSON.stringify({ granted: false, operation: null }) });
  const fixture = fakeAgentDirectory('exit 1', [
    'IFS= read -r warmup',
    `printf '%s\\n' '${denied}'`,
    'IFS= read -r judgment',
    '/bin/sleep 0.05',
    `printf '%s\\n' '${denied}'`,
  ].join('\n'));
  temporaryDirectory = fixture.directory;

  const [first, second] = await Promise.all([
    classifyExternalActionWithHaiku('first judgment', 1_000),
    classifyExternalActionWithHaiku('second judgment', 1_000),
  ]);

  expect(first).toContain('"granted":false');
  expect(second).toContain('"granted":false');
});

it('teaches the classifier that passive imperatives grant the named action', () => {
  expect(EXTERNAL_ACTION_CLASSIFIER_PROMPT).toContain('the FE PR and branch needs to be relinked to CON-230');
  expect(EXTERNAL_ACTION_CLASSIFIER_PROMPT).toContain('The word "permission" is not required.');
});
