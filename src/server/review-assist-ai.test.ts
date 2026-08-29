import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { openDatabase } from './database.js';

const decision = {
  behavior: 'Adds a retry to the sync client.',
  state: 'Pending',
  changeType: 'new_code' as const,
  secondaryChangeTypes: [],
  hunks: [{ filePath: 'src/sync.ts', location: 'Line 10', lines: ['+retry(3);'] }],
};

/** The warm worker protocol is one result per message written to stdin: the
 * first is the priming turn the pool pays before any reviewer clicks, the
 * second is the real question. */
function mockStreamingWorker(answer = 'This adds a bounded retry around the sync call.', deltas: string[] = [], writes: string[] = []) {
  return vi.fn(() => {
    const emitter = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding?: (encoding: string) => void };
      stderr: EventEmitter;
      stdin: EventEmitter & { write: (chunk: string) => void; end?: () => void };
      kill: () => void;
    };
    emitter.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    emitter.stderr = new EventEmitter();
    let turns = 0;
    emitter.stdin = Object.assign(new EventEmitter(), {
      write: (chunk: string) => {
        writes.push(chunk);
        const isPrimingTurn = turns++ === 0;
        queueMicrotask(() => {
          if (!isPrimingTurn) {
            for (const text of deltas) {
              emitter.stdout.emit('data', `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'ignored' } } })}\n`);
              emitter.stdout.emit('data', `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })}\n`);
            }
          }
          emitter.stdout.emit('data', `${JSON.stringify({ type: 'result', is_error: false, result: isPrimingTurn ? 'ready' : answer })}\n`);
        });
      },
      end: () => {},
    });
    emitter.kill = () => {};
    return emitter;
  });
}

describe('requestReviewAssist caching', () => {
  it('spawns once for a question and reuses the persisted answer on a repeat request', async () => {
    vi.resetModules();
    const spawn = mockStreamingWorker();
    vi.doMock('node:child_process', () => ({ spawn }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');
    const database = openDatabase(':memory:');

    const first = await requestReviewAssist(database, 'explain', decision, null);
    expect(first).toBe('This adds a bounded retry around the sync call.');
    // One spawn for the turn itself, plus one for the replacement warm worker
    // proactively started right after so the next click still lands warm.
    const spawnCountAfterFirstTurn = spawn.mock.calls.length;
    expect(spawnCountAfterFirstTurn).toBeGreaterThan(0);

    const second = await requestReviewAssist(database, 'explain', decision, null);
    expect(second).toBe('This adds a bounded retry around the sync call.');
    // The second request is a cache hit: it must not spend another model turn.
    expect(spawn.mock.calls.length).toBe(spawnCountAfterFirstTurn);
  });

  it('coalesces concurrent cache misses for the same decision into one model turn', async () => {
    vi.resetModules();
    const writes: string[] = [];
    const spawn = mockStreamingWorker('SCORE: 25\nBounded change.', [], writes);
    vi.doMock('node:child_process', () => ({ spawn }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');
    const database = openDatabase(':memory:');

    const [first, second] = await Promise.all([
      requestReviewAssist(database, 'score_risk', decision, null),
      requestReviewAssist(database, 'score_risk', decision, null),
    ]);

    expect(first).toBe(second);
    expect(writes.filter((write) => write.includes('rate how risky this change is'))).toHaveLength(1);
  });

  it('keys a score on the decision alone, so a background-computed score survives any task intent', async () => {
    vi.resetModules();
    const spawn = mockStreamingWorker('SCORE: 30\nNarrow change.');
    vi.doMock('node:child_process', () => ({ spawn }));
    const { lookupReviewAssist, requestReviewAssist } = await import('./review-assist-ai.js');
    const database = openDatabase(':memory:');

    // What the background pass computes: no task intent, because a risk score's
    // prompt never reads one.
    await requestReviewAssist(database, 'score_risk', decision, null);

    // What a reviewer's open panel asks for, carrying whatever intent its
    // window derived. It must still be a cache hit.
    expect(lookupReviewAssist(database, 'score_risk', decision, { title: 'Ship sync retries', description: 'Retry transient failures.' }))
      .toBe('SCORE: 30\nNarrow change.');
    // Intent still keys the one action whose prompt actually includes it.
    expect(lookupReviewAssist(database, 'compare_task_intent', decision, null)).toBeNull();
  });

  it('keeps a persisted answer when the reviewer settles the decision', async () => {
    vi.resetModules();
    const spawn = mockStreamingWorker('SCORE: 12\nTest-only assertion update.');
    vi.doMock('node:child_process', () => ({ spawn }));
    const { lookupReviewAssist, requestReviewAssist } = await import('./review-assist-ai.js');
    const database = openDatabase(':memory:');

    await requestReviewAssist(database, 'score_risk', decision, null);
    const spawnsAfterFirstTurn = spawn.mock.calls.length;

    // Marking a decision Reviewed changes nothing about what the code does.
    // Re-asking must be a cache hit, or every settled hunk would be rescored on
    // the next visit to Changes.
    const settled = { ...decision, state: 'Approved' };
    expect(lookupReviewAssist(database, 'score_risk', settled, null)).toBe('SCORE: 12\nTest-only assertion update.');
    expect(await requestReviewAssist(database, 'score_risk', settled, null)).toBe('SCORE: 12\nTest-only assertion update.');
    expect(spawn.mock.calls.length).toBe(spawnsAfterFirstTurn);
  });

  it('tells the model that a file path decides blast radius, so test files are not scored as production risk', async () => {
    vi.resetModules();
    const spawn = mockStreamingWorker('SCORE: 8\nAssertion update in a test file.');
    vi.doMock('node:child_process', () => ({ spawn }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');
    const database = openDatabase(':memory:');

    await requestReviewAssist(database, 'score_risk', {
      behavior: 'Changes the range filter assertions.',
      state: 'Pending',
      changeType: 'test_only' as const,
      secondaryChangeTypes: [],
      hunks: [{ filePath: 'src/client/features/range-filter.test.tsx', location: 'Line 42', lines: ["+    expect(screen.getByRole('button', { name: '7 days' })).toBeTruthy();"] }],
    }, null);

    const systemPrompt = (spawn.mock.calls as unknown as unknown[][])
      .map((call) => (Array.isArray(call[1]) ? call[1] as string[] : []))
      .map((argv) => argv[argv.indexOf('--system-prompt') + 1])
      .find((prompt) => typeof prompt === 'string');
    expect(systemPrompt).toContain('*.test.*');
    expect(systemPrompt).toContain('Read the path before judging the lines.');
  });

  it('reports a failed turn instead of silently caching a neutral placeholder', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      spawn: () => {
        const emitter = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { write: () => void }; kill: () => void };
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        emitter.stdin = Object.assign(new EventEmitter(), { write: () => {} });
        emitter.kill = () => {};
        queueMicrotask(() => emitter.emit('error', new Error('assist worker unavailable')));
        return emitter;
      },
    }));
    const { requestReviewAssist, lookupReviewAssist } = await import('./review-assist-ai.js');
    const database = openDatabase(':memory:');

    await expect(requestReviewAssist(database, 'what_could_break', decision, null)).rejects.toThrow();
    expect(lookupReviewAssist(database, 'what_could_break', decision, null)).toBeNull();
  });
});

describe('warm Changes agent', () => {
  it('primes its sessions at warm-up so a reviewer click never pays session startup', async () => {
    vi.resetModules();
    const spawn = mockStreamingWorker();
    vi.doMock('node:child_process', () => ({ spawn }));
    const { requestReviewAssist, warmReviewAssist, shutdownReviewAssist } = await import('./review-assist-ai.js');
    const database = openDatabase(':memory:');

    warmReviewAssist();
    const warmSpawns = spawn.mock.calls.length;
    expect(warmSpawns).toBeGreaterThan(0);
    // Every warmed session is primed immediately: its first (throwaway) turn is
    // written at spawn, so the reviewer's turn is a later, fast one.
    expect((spawn.mock.calls as unknown as unknown[][]).every((call) => (call[1] as string[]).includes('--include-partial-messages'))).toBe(true);

    await expect(requestReviewAssist(database, 'explain', decision, null)).resolves.toBe('This adds a bounded retry around the sync call.');
    // The click reused an already-warm session rather than starting one for itself.
    expect(spawn.mock.calls.length).toBeGreaterThanOrEqual(warmSpawns);
    shutdownReviewAssist();
  });

  it('streams answer text as it is generated and drops model thinking', async () => {
    vi.resetModules();
    const spawn = mockStreamingWorker('Bounded retry added.', ['Bounded ', 'retry ', 'added.']);
    vi.doMock('node:child_process', () => ({ spawn }));
    const { requestReviewAssist, shutdownReviewAssist } = await import('./review-assist-ai.js');
    const database = openDatabase(':memory:');

    const deltas: string[] = [];
    await expect(requestReviewAssist(database, 'explain', decision, null, (text) => deltas.push(text))).resolves.toBe('Bounded retry added.');
    expect(deltas).toEqual(['Bounded ', 'retry ', 'added.']);
    shutdownReviewAssist();
  });
});

describe('lookupReviewAssist', () => {
  it('returns null without spawning when nothing has been cached yet', async () => {
    vi.resetModules();
    const spawn = vi.fn();
    vi.doMock('node:child_process', () => ({ spawn }));
    const { lookupReviewAssist } = await import('./review-assist-ai.js');
    const database = openDatabase(':memory:');

    expect(lookupReviewAssist(database, 'compare_task_intent', decision, null)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('change-type obligations', () => {
  const deletion = {
    behavior: 'Removes the legacy parser.',
    state: 'Pending',
    changeType: 'deletion' as const,
    secondaryChangeTypes: [],
    hunks: [{ filePath: 'src/legacy-parse.ts', location: 'Lines 1-9', lines: ['-export function legacyParse(input: string) {', '-  return input.trim();', '-}'] }],
  };

  it('asks a deletion why, and forbids the all-clear it has no evidence for', async () => {
    vi.resetModules();
    const writes: string[] = [];
    const spawn = mockStreamingWorker('Removed with no visible reason.', [], writes);
    vi.doMock('node:child_process', () => ({ spawn }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');

    await requestReviewAssist(openDatabase(':memory:'), 'explain', deletion, null);

    // The priming turn is written first; the reviewer's question is the last.
    const prompt = writes[writes.length - 1];
    expect(prompt).toContain('Change type: Deletion.');
    expect(prompt).toContain('say plainly when the reason is not visible');
    // The worker has no tools and no repo: an assistant that answers "nothing
    // else references this" is inventing the only evidence that matters.
    expect(prompt).toContain('never as safe');
    expect(spawn.mock.calls.length).toBeGreaterThan(0);
  });

  it('keys the cache on change type, so the same lines asked as a different kind of change are not served a stale answer', async () => {
    vi.resetModules();
    const spawn = mockStreamingWorker('Removed with no visible reason.');
    vi.doMock('node:child_process', () => ({ spawn }));
    const { requestReviewAssist, lookupReviewAssist } = await import('./review-assist-ai.js');
    const database = openDatabase(':memory:');

    await requestReviewAssist(database, 'explain', deletion, null);
    expect(lookupReviewAssist(database, 'explain', deletion, null)).toBe('Removed with no visible reason.');
    expect(lookupReviewAssist(database, 'explain', { ...deletion, changeType: 'refactor_pure' as const }, null)).toBeNull();
  });
});

describe('surviving-reference evidence', () => {
  const deletion = {
    behavior: 'Removes the legacy parser.',
    state: 'Pending',
    changeType: 'deletion' as const,
    secondaryChangeTypes: [],
    hunks: [{ filePath: 'src/legacy-parse.ts', location: 'Lines 1-9', lines: ['-export function legacyParse(input: string) {', '-  return input.trim();', '-}'] }],
  };
  const residual = {
    ...deletion,
    referenceEvidence: {
      symbols: ['legacyParse'],
      hunks: [{ filePath: 'src/importer.ts', location: 'Lines 20-21', lines: ['   return legacyParse(raw);'], symbols: ['legacyParse'], kind: 'residual' as const }],
      residualSymbols: ['legacyParse'],
      clearedSymbols: [],
    },
  };

  it('hands the model the surviving call site, so a deletion break is cited rather than guessed', async () => {
    vi.resetModules();
    const writes: string[] = [];
    const spawn = mockStreamingWorker('Still referenced.', [], writes);
    vi.doMock('node:child_process', () => ({ spawn }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');

    await requestReviewAssist(openDatabase(':memory:'), 'explain', residual, null);

    const prompt = writes[writes.length - 1];
    expect(prompt).toContain('src/importer.ts');
    expect(prompt).toContain('Still referenced after this change: legacyParse');
    expect(prompt).toContain('report a break, not a possibility');
  });

  it('states an absent reference as narrowed risk rather than an all-clear, because the review is not the repository', async () => {
    vi.resetModules();
    const writes: string[] = [];
    const spawn = mockStreamingWorker('Nothing here uses it.', [], writes);
    vi.doMock('node:child_process', () => ({ spawn }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');

    await requestReviewAssist(openDatabase(':memory:'), 'explain', {
      ...deletion,
      referenceEvidence: { symbols: ['legacyParse'], hunks: [], residualSymbols: [], clearedSymbols: ['legacyParse'] },
    }, null);

    const prompt = writes[writes.length - 1];
    expect(prompt).toContain('narrows the risk without clearing it');
    expect(prompt).toContain('remain unverified');
  });

  it('keys the cache on the evidence, so a later push that adds a caller is not served the old all-clear', async () => {
    vi.resetModules();
    const spawn = mockStreamingWorker('Nothing here uses it.');
    vi.doMock('node:child_process', () => ({ spawn }));
    const { requestReviewAssist, lookupReviewAssist } = await import('./review-assist-ai.js');
    const database = openDatabase(':memory:');

    await requestReviewAssist(database, 'explain', deletion, null);
    expect(lookupReviewAssist(database, 'explain', deletion, null)).toBe('Nothing here uses it.');
    // Same decision, same lines — only the surrounding review changed. The old
    // answer must not survive that.
    expect(lookupReviewAssist(database, 'explain', residual, null)).toBeNull();
  });
});

describe('parity table contract', () => {
  const refactor = {
    behavior: 'Extracts the retry loop into a helper.',
    state: 'Pending',
    changeType: 'refactor_pure' as const,
    secondaryChangeTypes: [],
    hunks: [{ filePath: 'src/sync.ts', location: 'Lines 10-14', lines: ['-  for (let i = 0; i < 3; i += 1) {', '+  return retry(3, () => send());'] }],
  };

  it('asks a refactor for the four axes when the reviewer asks what could break', async () => {
    vi.resetModules();
    const writes: string[] = [];
    vi.doMock('node:child_process', () => ({ spawn: mockStreamingWorker('SIGNATURE: SAME — identical.\nERROR HANDLING: SAME — identical.\nORDERING: SAME — identical.\nCOMPLEXITY: SAME — identical.', [], writes) }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');

    await requestReviewAssist(openDatabase(':memory:'), 'what_could_break', refactor, null);

    const prompt = writes[writes.length - 1];
    expect(prompt).toContain('SIGNATURE, ERROR HANDLING, ORDERING, COMPLEXITY');
    expect(prompt).toContain('never SAME');
  });

  // `explain` is capped at three sentences and `score_risk` at the two lines the
  // client parses into a badge. A four-line table there would break the shape
  // rather than add rigour.
  it('leaves the shorter actions alone, whose output shapes a table would break', async () => {
    vi.resetModules();
    const writes: string[] = [];
    vi.doMock('node:child_process', () => ({ spawn: mockStreamingWorker('Extracted a helper.', [], writes) }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');

    await requestReviewAssist(openDatabase(':memory:'), 'explain', refactor, null);

    expect(writes[writes.length - 1]).not.toContain('parity table');
  });

  it('does not demand a parity table of a change that is meant to differ', async () => {
    vi.resetModules();
    const writes: string[] = [];
    vi.doMock('node:child_process', () => ({ spawn: mockStreamingWorker('Nothing obvious.', [], writes) }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');

    await requestReviewAssist(openDatabase(':memory:'), 'what_could_break', { ...refactor, changeType: 'behavior_edit' as const }, null);

    expect(writes[writes.length - 1]).not.toContain('parity table');
  });

  it('reports the axes a refactor answer skipped, so silence does not read as equivalence', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ spawn: mockStreamingWorker('SIGNATURE: SAME — identical.\nERROR HANDLING: SAME — identical.') }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');

    const answer = await requestReviewAssist(openDatabase(':memory:'), 'what_could_break', refactor, null);

    expect(answer).toContain('Parity check: ordering, complexity not compared');
  });
});

describe('reference-claim audit', () => {
  const deletion = {
    behavior: 'Removes the legacy parser.',
    state: 'Pending',
    changeType: 'deletion' as const,
    secondaryChangeTypes: [],
    hunks: [{ filePath: 'src/legacy-parse.ts', location: 'Lines 1-9', lines: ['-export function legacyParse(input: string) {', '-  return input.trim();', '-}'] }],
  };

  it('contradicts an all-clear about callers with the surviving reference the review already found', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ spawn: mockStreamingWorker('All call sites are updated.') }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');

    const answer = await requestReviewAssist(openDatabase(':memory:'), 'what_could_break', {
      ...deletion,
      referenceEvidence: {
        symbols: ['legacyParse'],
        hunks: [{ filePath: 'src/importer.ts', location: 'Lines 20-21', lines: ['   return legacyParse(raw);'], symbols: ['legacyParse'], kind: 'residual' as const }],
        residualSymbols: ['legacyParse'],
        clearedSymbols: [],
      },
    }, null);

    expect(answer).toContain('Reference check: this review still references legacyParse on a surviving line');
  });

  it('marks an unbacked all-clear unverified when no reference evidence was supplied at all', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ spawn: mockStreamingWorker('The callers were updated already.') }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');

    const answer = await requestReviewAssist(openDatabase(':memory:'), 'explain', deletion, null);

    expect(answer).toContain('cite no supplied hunk and remain unverified');
  });

  // The badge parses the first line of a score; a third line would break it,
  // and the action asks for no claims to audit in the first place.
  it('never appends a note to a score, whose two-line shape the client parses', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ spawn: mockStreamingWorker('SCORE: 55\nAll call sites are updated.') }));
    const { requestReviewAssist } = await import('./review-assist-ai.js');

    expect(await requestReviewAssist(openDatabase(':memory:'), 'score_risk', deletion, null)).toBe('SCORE: 55\nAll call sites are updated.');
  });
});
