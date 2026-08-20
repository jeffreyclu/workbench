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
});
