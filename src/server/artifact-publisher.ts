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

export interface ArtifactPageOptions {
  /** Version badge shown to coworkers. Omitted for a bare render. */
  version?: number;
  publishedAt?: string;
  /** Set on archived version snapshots so readers can jump to the current one. */
  latestUrl?: string;
  /** Enables the coworker feedback box. Null keeps the page fully offline. */
  feedback?: { artifactId: string; endpointOrigin: string } | null;
}

export interface PublishInput {
  id: string;
  title: string;
  sourcePath: string;
  version: number;
  feedback?: { artifactId: string; endpointOrigin: string } | null;
}

export interface ArtifactPublisher {
  publish(input: PublishInput): Promise<PublishedArtifact>;
  revoke(id: string): Promise<void>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/**
 * Everything Workbench adds to a shared page lives inside `.wb-artifact-meta`
 * and only ever sets properties on its own elements, so an artifact's own
 * styling is untouched. The feedback box is omitted unless feedback is
 * configured, which keeps the default page free of scripts and network access.
 */
function renderPageFooter(options: ArtifactPageOptions): string {
  if (!options.version && !options.feedback && !options.latestUrl) return '';
  const published = options.publishedAt ? new Date(options.publishedAt) : null;
  const publishedLabel = published && !Number.isNaN(published.valueOf())
    ? published.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
  const styles = `<style>.wb-artifact-meta{max-width:860px;margin:56px auto 40px;padding:16px 20px;border-top:1px solid rgba(128,128,128,.35);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#8b8a83}.wb-artifact-meta strong{font-weight:700}.wb-artifact-meta a{color:inherit}.wb-artifact-meta form{display:grid;gap:8px;margin-top:14px}.wb-artifact-meta input,.wb-artifact-meta textarea{width:100%;padding:9px 11px;border:1px solid rgba(128,128,128,.4);border-radius:8px;background:transparent;color:inherit;font:inherit}.wb-artifact-meta button{justify-self:start;padding:9px 15px;border:0;border-radius:8px;background:#c6f432;color:#111;font:inherit;font-weight:700;cursor:pointer}.wb-artifact-meta button:disabled{opacity:.6;cursor:wait}.wb-artifact-meta p{margin:6px 0 0}@media(max-width:600px){.wb-artifact-meta{margin:36px 16px 28px;padding:14px 0}}</style>`;
  const stale = options.latestUrl ? ` &middot; <a href="${escapeHtml(options.latestUrl)}">View the latest version</a>` : '';
  const line = `<p><strong>Version ${options.version ?? 1}</strong>${publishedLabel ? ` &middot; published ${escapeHtml(publishedLabel)}` : ''}${stale}</p>`;
  const feedback = options.feedback
    ? `<form id="wb-feedback"><label for="wb-feedback-name">Feedback for the author</label><input id="wb-feedback-name" name="author" placeholder="Your name" maxlength="80" autocomplete="name"><textarea id="wb-feedback-body" name="body" rows="3" placeholder="What should change?" maxlength="5000" required></textarea><button type="submit">Send feedback</button><p id="wb-feedback-status" role="status"></p></form>`
      + `<script>(function(){var form=document.getElementById('wb-feedback');var status=document.getElementById('wb-feedback-status');var endpoint=${JSON.stringify(`${options.feedback.endpointOrigin}/api/artifacts/${options.feedback.artifactId}/comments`)};var version=${options.version ?? 1};form.addEventListener('submit',function(event){event.preventDefault();var button=form.querySelector('button');var body=document.getElementById('wb-feedback-body').value.trim();if(!body)return;button.disabled=true;status.textContent='Sending…';fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({author:document.getElementById('wb-feedback-name').value.trim()||'Coworker',body:body,version:version})}).then(function(response){if(!response.ok)throw new Error('Feedback was not delivered.');form.reset();status.textContent='Thanks — the author has your feedback.';}).catch(function(){button.disabled=false;status.textContent='Could not send that. Try again, or reply wherever you got this link.';});});})();</script>`
    : '';
  return `${styles}<footer class="wb-artifact-meta">${line}${feedback}</footer>`;
}

function injectFooter(page: string, footer: string): string {
  if (!footer) return page;
  return /<\/body>/i.test(page) ? page.replace(/<\/body>/i, `${footer}</body>`) : `${page}${footer}`;
}

export function renderArtifactPage(sourcePath: string, title: string, options: ArtifactPageOptions = {}): string {
  const extension = extname(sourcePath).toLowerCase();
  const source = readFileSync(sourcePath, 'utf8');
  const footer = renderPageFooter(options);
  // Feedback is the only reason a shared page ever reaches the network, so the
  // connect-src opens for exactly one origin and only when it is configured.
  const connectSource = options.feedback ? options.feedback.endpointOrigin : "'none'";
  if (extension === '.html' || extension === '.htm') {
    const withoutPriorPolicy = source.replace(/<meta\s+[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
    const security = `<meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src ${connectSource}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">`;
    const page = /<head(?:\s[^>]*)?>/i.test(withoutPriorPolicy)
      ? withoutPriorPolicy.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${security}`)
      : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${security}</head><body>${withoutPriorPolicy}</body></html>`;
    return injectFooter(page, footer);
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
  const scriptSource = options.feedback ? " script-src 'unsafe-inline';" : '';
  const policy = `default-src 'none'; img-src https: data:; style-src 'unsafe-inline';${scriptSource} font-src https: data:; connect-src ${connectSource}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>${escapeHtml(title)}</title>${defaultStyles}</head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
  return injectFooter(page, footer);
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

  /**
   * Writes two copies of the snapshot: `/<id>/` always serves the current
   * version, and `/<id>/v<n>/` keeps that exact version reachable after later
   * republishes. A link someone already shared never silently changes meaning.
   */
  async publish(input: PublishInput): Promise<PublishedArtifact> {
    const { baseUrl } = this.configuration();
    const artifactDirectory = resolve(this.outputDirectory, input.id);
    const versionDirectory = resolve(artifactDirectory, `v${input.version}`);
    mkdirSync(versionDirectory, { recursive: true });
    const publishedAt = new Date().toISOString();
    const feedback = input.feedback ?? null;
    writeFileSync(resolve(artifactDirectory, 'index.html'), renderArtifactPage(input.sourcePath, input.title, { version: input.version, publishedAt, feedback }));
    writeFileSync(resolve(versionDirectory, 'index.html'), renderArtifactPage(input.sourcePath, input.title, { version: input.version, publishedAt, latestUrl: '../', feedback }));
    await this.deploy();
    return { id: input.id, title: input.title, url: `${baseUrl}/${input.id}/` };
  }

  versionUrl(id: string, version: number): string {
    return `${this.configuration().baseUrl}/${id}/v${version}/`;
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
