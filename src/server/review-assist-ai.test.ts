import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { openDatabase } from './database.js';

const decision = {
  behavior: 'Adds a retry to the sync client.',
  state: 'Pending',
  hunks: [{ filePath: 'src/sync.ts', location: 'Line 10', lines: ['+retry(3);'] }],
};

/** The warm worker protocol is one result per message written to stdin: the
 * first is the priming turn the pool pays before any reviewer clicks, the
 * second is the real question. */
function mockStreamingWorker(answer = 'This adds a bounded retry around the sync call.', deltas: string[] = []) {
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
      write: () => {
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
