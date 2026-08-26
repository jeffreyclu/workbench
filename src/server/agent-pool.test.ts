import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { claimWarmProcess, hasWarmProcess, idlePoolSizeForTest, resetPoolForTest, warmProcess } from './agent-pool.js';

function spawnLongLived() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: ['pipe', 'pipe', 'pipe'] });
}

afterEach(() => {
  resetPoolForTest();
});

describe('agent-pool', () => {
  it('claims a warm process only when agent, cwd, command and args all match', () => {
    const child = spawnLongLived();
    warmProcess('claude', '/repo', 'claude', ['--foo'], child);

    expect(claimWarmProcess('claude', '/repo', 'claude', ['--bar'])).toBeNull();
    expect(claimWarmProcess('codex', '/repo', 'claude', ['--foo'])).toBeNull();
    expect(claimWarmProcess('claude', '/other', 'claude', ['--foo'])).toBeNull();

    const claimed = claimWarmProcess('claude', '/repo', 'claude', ['--foo']);
    expect(claimed).toBe(child);
    child.kill();
  });

  it('never hands out the same process twice', () => {
    const child = spawnLongLived();
    warmProcess('claude', '/repo', 'claude', ['--foo'], child);

    expect(claimWarmProcess('claude', '/repo', 'claude', ['--foo'])).toBe(child);
    expect(claimWarmProcess('claude', '/repo', 'claude', ['--foo'])).toBeNull();
    child.kill();
  });

  it('reports whether a matching warm process is idle without consuming it', () => {
    const child = spawnLongLived();
    warmProcess('claude', '/repo', 'claude', ['--foo'], child);

    expect(hasWarmProcess('claude', '/repo', 'claude', ['--foo'])).toBe(true);
    expect(idlePoolSizeForTest('claude', '/repo')).toBe(1);
    expect(hasWarmProcess('claude', '/repo', 'claude', ['--foo'])).toBe(true);
    child.kill();
  });

  it('drops an already-exited process instead of handing it out', async () => {
    const child = spawnLongLived();
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    warmProcess('claude', '/repo', 'claude', ['--foo'], child);

    expect(claimWarmProcess('claude', '/repo', 'claude', ['--foo'])).toBeNull();
  });

  it('caps idle processes per key and kills the excess', () => {
    const first = spawnLongLived();
    const second = spawnLongLived();
    warmProcess('claude', '/repo', 'claude', ['--foo'], first);
    warmProcess('claude', '/repo', 'claude', ['--foo'], second);

    expect(idlePoolSizeForTest('claude', '/repo')).toBe(1);
    expect(claimWarmProcess('claude', '/repo', 'claude', ['--foo'])).toBe(first);
    first.kill();
  });
});
