import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderArtifactPage } from './artifact-publisher.js';

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

  it('adds a feedback box only when feedback is configured, and opens exactly one origin', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-artifact-'));
    const path = join(directory, 'report.md');
    writeFileSync(path, '# Rollout');
    const page = renderArtifactPage(path, 'Rollout', {
      version: 2,
      feedback: { artifactId: 'abc123', endpointOrigin: 'https://jeffrey.ngrok-free.app' },
    });

    expect(page).toContain('Send feedback');
    expect(page).toContain('https://jeffrey.ngrok-free.app/api/artifacts/abc123/comments');
    expect(page).toContain("connect-src https://jeffrey.ngrok-free.app");
    expect(page).toContain("script-src 'unsafe-inline'");
    expect(page).not.toContain("connect-src 'none'");

    const withoutFeedback = renderArtifactPage(path, 'Rollout', { version: 2 });
    expect(withoutFeedback).not.toContain('Send feedback');
    expect(withoutFeedback).not.toContain('<script');
  });
});
