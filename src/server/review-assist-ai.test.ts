import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { openDatabase } from './database.js';

const decision = {
  behavior: 'Adds a retry to the sync client.',
  state: 'Pending',
  hunks: [{ filePath: 'src/sync.ts', location: 'Line 10', lines: ['+retry(3);'] }],
};

function mockStreamingWorker() {
  return vi.fn(() => {
    const emitter = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding?: (encoding: string) => void };
      stderr: EventEmitter;
      stdin: EventEmitter & { write: (chunk: string) => void; end?: () => void };
      kill: () => void;
    };
    emitter.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    emitter.stderr = new EventEmitter();
    emitter.stdin = Object.assign(new EventEmitter(), { write: () => {}, end: () => {} });
    emitter.kill = () => {};
    queueMicrotask(() => emitter.stdout.emit('data', `${JSON.stringify({ type: 'result', is_error: false, result: 'This adds a bounded retry around the sync call.' })}\n`));
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
