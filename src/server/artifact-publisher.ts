import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const execFileAsync = promisify(execFile);

export interface PublishedArtifact {
  id: string;
  url: string;
  title: string;
}

export interface ArtifactPublisher {
  publish(input: { id: string; title: string; sourcePath: string }): Promise<PublishedArtifact>;
  revoke(id: string): Promise<void>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function renderArtifactPage(sourcePath: string, title: string): string {
  const extension = extname(sourcePath).toLowerCase();
  const source = readFileSync(sourcePath, 'utf8');
  if (extension === '.html' || extension === '.htm') {
    const withoutPriorPolicy = source.replace(/<meta\s+[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
    const security = `<meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">`;
    return /<head(?:\s[^>]*)?>/i.test(withoutPriorPolicy)
      ? withoutPriorPolicy.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${security}`)
      : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${security}</head><body>${withoutPriorPolicy}</body></html>`;
  }
  const rendered = extension === '.md' || extension === '.markdown'
    ? marked.parse(source, { async: false })
    : `<pre>${escapeHtml(source)}</pre>`;
  const content = sanitizeHtml(String(rendered), {
    // Local agent artifacts are trusted design output. CSP still blocks scripts,
    // forms, frames, and non-image network access; preserving CSS is the point here.
    allowVulnerableTags: true,
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'details', 'summary', 'style']),
    allowedAttributes: { a: ['href', 'name', 'target', 'rel', 'class', 'style'], img: ['src', 'alt', 'title', 'width', 'height', 'class', 'style'], '*': ['class', 'id', 'style'] },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noreferrer noopener', target: '_blank' }) },
  });
  const defaultStyles = `<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#10100f;color:#d7d6cf;font:16px/1.65 ui-sans-serif,system-ui,-apple-system,sans-serif}main{width:min(860px,calc(100% - 40px));margin:64px auto 100px}h1{margin:0 0 36px;color:#f4f3ed;font-size:clamp(30px,5vw,48px);line-height:1.08}h2,h3{margin-top:2em;color:#f0efe8}a{color:#c6f432}pre{overflow:auto;padding:18px;background:#090909;border:1px solid #30302c;border-radius:10px;white-space:pre-wrap}code{font-family:ui-monospace,SFMono-Regular,monospace}table{display:block;overflow:auto;border-collapse:collapse}th,td{padding:8px 11px;border:1px solid #353530;text-align:left}img{max-width:100%;height:auto;border-radius:8px}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #71832d;color:#aaa99f}</style>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><title>${escapeHtml(title)}</title>${defaultStyles}</head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
}

export class CloudflarePagesPublisher implements ArtifactPublisher {
  private readonly outputDirectory = resolve(process.env.ARTIFACT_OUTPUT_DIRECTORY ?? 'data/published');
  private readonly project = process.env.ARTIFACT_PAGES_PROJECT?.trim();
  private readonly baseUrl = process.env.ARTIFACT_PUBLIC_BASE_URL?.trim().replace(/\/$/, '');

  private configuration(): { project: string; baseUrl: string } {
    if (!this.project || !this.baseUrl) throw new Error('Artifact publishing is not configured. Set ARTIFACT_PAGES_PROJECT and ARTIFACT_PUBLIC_BASE_URL.');
    return { project: this.project, baseUrl: this.baseUrl };
  }

  private async deploy(): Promise<void> {
    const { project } = this.configuration();
    await execFileAsync('npx', ['--yes', 'wrangler', 'pages', 'deploy', this.outputDirectory, '--project-name', project, '--branch', 'main', '--commit-dirty=true'], {
      env: process.env, timeout: 120_000, maxBuffer: 2_000_000,
    });
    await this.pruneOldDeployments(project);
  }

  private async pruneOldDeployments(project: string): Promise<void> {
    const { stdout } = await execFileAsync('npx', ['--yes', 'wrangler', 'pages', 'deployment', 'list', '--project-name', project, '--json'], {
      env: process.env, timeout: 30_000, maxBuffer: 2_000_000,
    });
    const deployments = JSON.parse(stdout) as Array<{ Id: string; Environment: string }>;
    const production = deployments.filter((entry) => entry.Environment === 'Production');
    for (const deployment of production.slice(1)) {
      try {
        await execFileAsync('npx', ['--yes', 'wrangler', 'pages', 'deployment', 'delete', deployment.Id, '--project-name', project, '--force'], {
          env: process.env, timeout: 30_000, maxBuffer: 2_000_000,
        });
      } catch (error) {
        console.warn(`Could not delete superseded Pages deployment ${deployment.Id}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  async publish(input: { id: string; title: string; sourcePath: string }): Promise<PublishedArtifact> {
    const { baseUrl } = this.configuration();
    const artifactDirectory = resolve(this.outputDirectory, input.id);
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(resolve(artifactDirectory, 'index.html'), renderArtifactPage(input.sourcePath, input.title));
    await this.deploy();
    return { id: input.id, title: input.title, url: `${baseUrl}/${input.id}/` };
  }

  async revoke(id: string): Promise<void> {
    this.configuration();
    rmSync(resolve(this.outputDirectory, id), { recursive: true, force: true });
    await this.deploy();
  }

  removeLocal(id: string): void {
    rmSync(resolve(this.outputDirectory, id), { recursive: true, force: true });
  }
}

export function createArtifactId(): string {
  return randomBytes(12).toString('base64url');
}

export function artifactContentHash(sourcePath: string, title: string): string {
  return createHash('sha256').update(renderArtifactPage(sourcePath, title)).digest('hex');
}
