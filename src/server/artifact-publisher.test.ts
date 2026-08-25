import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addFeedbackToPublishedPage, reconcileArtifactDirectory, renderArtifactPage, repairLegacyArtifactSnapshots } from './artifact-publisher.js';

describe('artifact snapshots', () => {
  it('renders Markdown while removing active content', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-'));
    const path = join(directory, 'report.md');
    writeFileSync(path, '# Finding\n\n[Safe](https://example.com)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>');
    const page = renderArtifactPage(path, 'Agent report');

    expect(page).toContain('<h1>Agent report</h1>');
    expect(page).toContain('<h1>Finding</h1>');
    expect(page).toContain('https://example.com');
    expect(page).not.toContain('<script>');
    expect(page).not.toContain('onerror');
    expect(page).toContain("default-src 'none'");
  });

  it('keeps interactive HTML intact while constraining its network access', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-'));
    const path = join(directory, 'report.html');
    writeFileSync(path, '<!doctype html><html><head><style>.report { color: hotpink; }</style></head><body><button id="theme">Theme</button><svg><circle cx="2" cy="2" r="2"/></svg><script>document.querySelector("#theme").textContent = "☀"</script></body></html>');
    const page = renderArtifactPage(path, 'Styled report');

    expect(page).toContain('.report { color: hotpink; }');
    expect(page).toContain('<svg><circle cx="2" cy="2" r="2"/></svg>');
    expect(page).toContain('<script>document.querySelector("#theme").textContent = "☀"</script>');
    expect(page).toContain("connect-src 'none'");
    expect(page).toContain("script-src 'unsafe-inline' https://cdn.jsdelivr.net");
  });

  it('stamps the version and publication date without disturbing the artifact styling', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-'));
    const path = join(directory, 'report.html');
    writeFileSync(path, '<!doctype html><html><head><style>.report { color: hotpink; }</style></head><body><h1 class="report">Rollout</h1></body></html>');
    const page = renderArtifactPage(path, 'Rollout', { version: 3, publishedAt: '2026-08-20T12:00:00.000Z' });

    expect(page).toContain('.report { color: hotpink; }');
    expect(page).toContain('<h1 class="report">Rollout</h1>');
    expect(page).toContain('<strong>Version 3</strong>');
    expect(page).toContain('published Aug 20, 2026');
    // Workbench chrome only ever styles its own footer.
    expect(page).toMatch(/<footer class="wb-artifact-meta">[\s\S]*<\/footer><\/body>/);
    expect(page).toContain("connect-src 'none'");
    expect(page).not.toContain('wb-feedback');
  });

  it('points an archived version snapshot at the current one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-'));
    const path = join(directory, 'report.md');
    writeFileSync(path, '# Rollout');
    const page = renderArtifactPage(path, 'Rollout', { version: 1, latestUrl: '../' });

    expect(page).toContain('<a href="../">View the latest version</a>');
  });

  it('adds row-anchored comments only when feedback is configured, and opens exactly one origin', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-'));
    const path = join(directory, 'report.md');
    writeFileSync(path, '# Rollout');
    const page = renderArtifactPage(path, 'Rollout', {
      version: 2,
      feedback: { artifactId: 'abc123', endpointOrigin: 'https://jeffrey.ngrok-free.app' },
    });

    expect(page).toContain('Comment on this row');
    expect(page).toContain('id="wb-comment-rail"');
    expect(page).toContain('anchor:anchorFor(selected)');
    expect(page).toContain('https://jeffrey.ngrok-free.app/api/artifacts/abc123/comments');
    expect(page).toContain("connect-src https://jeffrey.ngrok-free.app");
    expect(page).toContain("script-src 'unsafe-inline'");
    expect(page).not.toContain("connect-src 'none'");

    const withoutFeedback = renderArtifactPage(path, 'Rollout', { version: 2 });
    expect(withoutFeedback).not.toContain('id="wb-comment-rail"');
    expect(withoutFeedback).not.toContain('<script');
  });

  it('upgrades an existing public snapshot to row-anchored comments without changing the artifact content', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-'));
    const path = join(directory, 'report.md');
    writeFileSync(path, '# Rollout');
    const original = renderArtifactPage(path, 'Rollout', { version: 2 });
    const refreshed = addFeedbackToPublishedPage(original, { artifactId: 'abc123', endpointOrigin: 'https://workbench.example.com' });

    expect(refreshed).toContain('<h1>Rollout</h1>');
    expect(refreshed).toContain('<strong>Version 2</strong>');
    expect(refreshed).toContain('id="wb-comment-rail"');
    expect(refreshed).toContain('Comment on this row');
    expect(refreshed).toContain('https://workbench.example.com/api/artifacts/abc123/comments');
    expect(refreshed).toContain("connect-src https://workbench.example.com");
    expect(addFeedbackToPublishedPage(refreshed, { artifactId: 'abc123', endpointOrigin: 'https://workbench.example.com' })).toBe(refreshed);
  });

  it('replaces the old page-level composer when upgrading an existing snapshot', () => {
    const legacy = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; connect-src \'none\';"></head><body><main><table><tr><td>One</td></tr></table></main><footer class="wb-artifact-meta"><form id="wb-feedback"><textarea></textarea></form><script>legacy()</script></footer></body></html>';
    const refreshed = addFeedbackToPublishedPage(legacy, { artifactId: 'abc123', endpointOrigin: 'https://workbench.example.com' });

    expect(refreshed).not.toContain('id="wb-feedback"');
    expect(refreshed).toContain('id="wb-comment-rail"');
    expect(refreshed).toContain("connect-src https://workbench.example.com");
  });

  it('rebuilds current and historical URLs from immutable snapshots in a fresh directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-output-'));
    const result = reconcileArtifactDirectory(directory, [{
      id: 'report', sourcePath: '/source/no-longer-needed.md', title: 'Report', version: 2,
      snapshots: [{ version: 1, content: '<h1>Version one</h1>' }, { version: 2, content: '<h1>Version two</h1>' }],
    }]);

    expect(result).toEqual({ restored: ['report'], missing: [] });
    expect(readFileSync(join(directory, 'report/index.html'), 'utf8')).toContain('Version two');
    expect(readFileSync(join(directory, 'report/v1/index.html'), 'utf8')).toContain('Version one');
    expect(existsSync(join(directory, 'report/v2/index.html'))).toBe(true);
  });

  it('removes unexpected directories instead of carrying orphaned content into a deploy', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-output-'));
    writeFileSync(join(directory, 'orphan.html'), '<h1>Do not deploy me</h1>');
    const result = reconcileArtifactDirectory(directory, [{
      id: 'report', sourcePath: '/source/report.md', title: 'Report', version: 1,
      snapshots: [{ version: 1, content: '<h1>Canonical snapshot</h1>' }],
    }]);

    expect(result).toEqual({ restored: ['report'], missing: [] });
    expect(existsSync(join(directory, 'orphan.html'))).toBe(false);
    expect(readFileSync(join(directory, 'report/index.html'), 'utf8')).toContain('Canonical snapshot');
  });

  it('refuses a deployment manifest with a missing historical snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-output-'));
    const result = reconcileArtifactDirectory(directory, [{
      id: 'report', sourcePath: '/source/missing.md', title: 'Report', version: 2,
      snapshots: [{ version: 1, contentHash: 'expected-immutable-content', content: null }, { version: 2, content: '<h1>Version two</h1>' }],
    }]);

    expect(result).toEqual({ restored: [], missing: ['report'] });
    expect(existsSync(join(directory, 'report/index.html'))).toBe(false);
  });

  it('does not block a deployment on a non-current root-only history row created before version URLs existed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-output-'));
    const result = reconcileArtifactDirectory(directory, [{
      id: 'report', sourcePath: '/source/legacy.md', title: 'Report', version: 2,
      snapshots: [{ version: 1, content: null }, { version: 2, contentHash: 'current-hash', content: '<h1>Version two</h1>' }],
    }]);

    expect(result).toEqual({ restored: ['report'], missing: [] });
    expect(existsSync(join(directory, 'report/v1/index.html'))).toBe(false);
    expect(readFileSync(join(directory, 'report/v2/index.html'), 'utf8')).toContain('Version two');
  });

  it('imports legacy deployed pages without re-rendering mutable source files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-output-'));
    mkdirSync(join(directory, 'report', 'v1'), { recursive: true });
    mkdirSync(join(directory, 'current'), { recursive: true });
    writeFileSync(join(directory, 'report', 'v1', 'index.html'), '<h1>Published version</h1>', { flag: 'w' });
    writeFileSync(join(directory, 'current', 'index.html'), '<h1>Current published version</h1>', { flag: 'w' });
    const restored: Array<{ id: string; version: number; content: string }> = [];
    const result = repairLegacyArtifactSnapshots(directory, [
      { id: 'report', sourcePath: '/source/report.md', title: 'Report', version: 1, snapshots: [{ version: 1, content: null }] },
      { id: 'current', sourcePath: '/source/current.md', title: 'Current', version: 1, snapshots: [{ version: 1, content: null }] },
      { id: 'missing', sourcePath: '/source/missing.md', title: 'Missing', version: 1, snapshots: [{ version: 1, content: null }] },
    ], (id, version, content) => { restored.push({ id, version, content }); return true; });

    expect(result).toEqual({ restored: [{ id: 'report', version: 1 }, { id: 'current', version: 1 }], missing: [{ id: 'missing', version: 1 }] });
    expect(restored).toEqual([
      { id: 'report', version: 1, content: '<h1>Published version</h1>' },
      { id: 'current', version: 1, content: '<h1>Current published version</h1>' },
    ]);
  });
});
