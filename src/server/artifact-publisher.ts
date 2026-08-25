import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { recordAudit } from './audit-log.js';

const execFileAsync = promisify(execFile);

export interface PublishedArtifact {
  id: string;
  url: string;
  title: string;
}

/** What the DB considers currently live for one published artifact. */
export interface LiveArtifact {
  id: string;
  sourcePath: string;
  title: string;
  version: number;
  snapshots: Array<{ version: number; content: string | null; contentHash?: string }>;
}

/**
 * Migration 015 created version history for older, mutable root-only shares.
 * Those backfilled rows have no content hash and, if they are no longer the
 * current version, never had a public immutable URL to keep alive.
 */
function isPreVersionedHistoricalSnapshot(artifact: LiveArtifact, snapshot: LiveArtifact['snapshots'][number]): boolean {
  return snapshot.version !== artifact.version && !snapshot.contentHash;
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
  renderedContent: string;
  publishedAt: string;
  feedback?: { artifactId: string; endpointOrigin: string } | null;
}

export interface ArtifactPublisher {
  publish(input: PublishInput, live: LiveArtifact[]): Promise<PublishedArtifact>;
  refreshFeedback(live: LiveArtifact[], feedback: NonNullable<ArtifactPageOptions['feedback']>): Promise<number>;
  revoke(id: string, live: LiveArtifact[], publicUrl: string): Promise<{ verified: boolean }>;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/**
 * Everything Workbench adds to a shared page lives inside `.wb-artifact-meta`
 * and only ever sets properties on its own elements, so an artifact's own
 * styling is untouched. The commenting layer is omitted unless feedback is
 * configured, which keeps the default page free of scripts and network access.
 */
function renderPageFooter(options: ArtifactPageOptions): string {
  if (!options.version && !options.feedback && !options.latestUrl) return '';
  const published = options.publishedAt ? new Date(options.publishedAt) : null;
  const publishedLabel = published && !Number.isNaN(published.valueOf())
    ? published.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
  const styles = `<style>.wb-artifact-meta{max-width:860px;margin:56px auto 40px;padding:16px 20px;border-top:1px solid rgba(128,128,128,.35);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#8b8a83}.wb-artifact-meta strong{font-weight:700}.wb-artifact-meta a{color:inherit}.wb-artifact-meta p{margin:6px 0 0}@media(max-width:600px){.wb-artifact-meta{margin:36px 16px 28px;padding:14px 0}}</style>`;
  const stale = options.latestUrl ? ` &middot; <a href="${escapeHtml(options.latestUrl)}">View the latest version</a>` : '';
  const line = `<p><strong>Version ${options.version ?? 1}</strong>${publishedLabel ? ` &middot; published ${escapeHtml(publishedLabel)}` : ''}${stale}</p>`;
  return `${styles}<footer class="wb-artifact-meta">${line}</footer>${options.feedback ? renderCommentingLayer(options.feedback, options.version ?? 1) : ''}`;
}

function renderCommentingLayer(feedback: NonNullable<ArtifactPageOptions['feedback']>, version: number): string {
  const endpoint = `${feedback.endpointOrigin}/api/artifacts/${feedback.artifactId}/comments`;
  return `<style data-wb-commenting-style>::highlight(wb-comment){background:rgba(198,244,50,.3)}.wb-comment-trigger{position:fixed;z-index:21;padding:8px 11px;border:0;border-radius:7px;background:#c6f432;color:#111;font:600 13px/1 ui-sans-serif,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.28);cursor:pointer}.wb-comment-rail{position:fixed;z-index:20;top:24px;right:24px;width:min(360px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;padding:18px;background:#191918;color:#d7d6cf;border:1px solid #44443d;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.35);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}.wb-comment-rail[hidden],.wb-comment-trigger[hidden]{display:none}.wb-comment-rail h2{margin:0;color:#f4f3ed;font-size:17px}.wb-comment-selection-label{margin:5px 0 16px;color:#aaa99f;font-size:12px}.wb-comment-close{float:right;border:0;background:none;color:#aaa99f;font:inherit;cursor:pointer}.wb-comment-thread{display:grid;gap:10px;margin:0 0 16px}.wb-comment-item{padding:10px;border:1px solid #353530;border-radius:8px;background:#10100f}.wb-comment-item p{margin:5px 0 0;white-space:pre-wrap}.wb-comment-empty{margin:0;color:#aaa99f}.wb-comment-form{display:grid;gap:8px}.wb-comment-form input,.wb-comment-form textarea{width:100%;padding:9px 11px;border:1px solid #4a4a43;border-radius:7px;background:#10100f;color:inherit;font:inherit}.wb-comment-form button{justify-self:start;padding:9px 13px;border:0;border-radius:7px;background:#c6f432;color:#111;font:inherit;font-weight:700;cursor:pointer}.wb-comment-form button:disabled{opacity:.6;cursor:wait}.wb-comment-status{min-height:20px;margin:0;color:#aaa99f;font-size:12px}@media(max-width:700px){.wb-comment-rail{top:auto;right:12px;bottom:12px;width:calc(100vw - 24px);max-height:68vh}}</style><button class="wb-comment-trigger" id="wb-comment-trigger" type="button" hidden>Comment</button><aside class="wb-comment-rail" id="wb-comment-rail" aria-label="Comments" hidden><button class="wb-comment-close" type="button" aria-label="Close comments">Close</button><h2>Comments</h2><p class="wb-comment-selection-label" id="wb-comment-selection-label">Select text in this page to comment.</p><div class="wb-comment-thread" id="wb-comment-thread"></div><form class="wb-comment-form" id="wb-comment-form"><label for="wb-comment-name">Your name</label><input id="wb-comment-name" name="author" placeholder="Your name" maxlength="80" autocomplete="name"><label for="wb-comment-body">Comment</label><textarea id="wb-comment-body" name="body" rows="4" placeholder="Leave a comment on the selected text" maxlength="5000" required></textarea><button type="submit">Comment</button><p class="wb-comment-status" id="wb-comment-status" role="status"></p></form></aside><script data-wb-commenting>(function(){var endpoint=${JSON.stringify(endpoint)},version=${version},main=document.querySelector('main'),rail=document.getElementById('wb-comment-rail'),trigger=document.getElementById('wb-comment-trigger'),form=document.getElementById('wb-comment-form'),thread=document.getElementById('wb-comment-thread'),label=document.getElementById('wb-comment-selection-label'),status=document.getElementById('wb-comment-status'),selected=null,comments=[];function esc(value){var node=document.createElement('span');node.textContent=value;return node.innerHTML}function rangeFor(anchor){var match=/^text:(\\d+):(\\d+)$/.exec(anchor||'');if(!match)return null;var start=+match[1],end=+match[2],walker=document.createTreeWalker(main,NodeFilter.SHOW_TEXT),node,position=0,result=document.createRange(),started=false;while(node=walker.nextNode()){var next=position+node.data.length;if(!started&&start>=position&&start<=next){result.setStart(node,start-position);started=true}if(started&&end>=position&&end<=next){result.setEnd(node,end-position);return result}position=next}return null}function anchorFor(range){var before=document.createRange();before.selectNodeContents(main);before.setEnd(range.startContainer,range.startOffset);return 'text:'+before.toString().length+':'+(before.toString().length+range.toString().length)}function activeRange(){var selection=window.getSelection();if(!selection||selection.rangeCount!==1||selection.isCollapsed)return null;var range=selection.getRangeAt(0);return main.contains(range.commonAncestorContainer)?range:null}function render(){thread.innerHTML='';var matches=selected?comments.filter(function(comment){return comment.anchor===selected.anchor}):comments;if(!matches.length){thread.innerHTML='<p class="wb-comment-empty">No comments here yet.</p>';return}matches.forEach(function(comment){var item=document.createElement('article');item.className='wb-comment-item';item.innerHTML='<strong>'+esc(comment.author)+'</strong><p>'+esc(comment.body)+'</p>';thread.appendChild(item)})}function select(range){selected={anchor:anchorFor(range),text:range.toString().trim()};label.textContent='Selected text: '+selected.text.slice(0,160);rail.hidden=false;render();document.getElementById('wb-comment-body').focus()}function showTrigger(){var range=activeRange();if(!range||!range.toString().trim()){trigger.hidden=true;return}var rect=range.getBoundingClientRect();trigger.style.top=(window.scrollY+rect.bottom+8)+'px';trigger.style.left=(window.scrollX+Math.max(12,rect.left))+'px';trigger.hidden=false}function highlight(){if(!CSS.highlights||!window.Highlight)return;var ranges=[];comments.forEach(function(comment){if(comment.resolvedAt)return;var range=rangeFor(comment.anchor);if(range)ranges.push(range)});CSS.highlights.set('wb-comment',new Highlight(...ranges))}function load(){fetch(endpoint).then(function(response){if(!response.ok)throw new Error();return response.json()}).then(function(payload){comments=payload.comments||[];highlight();render()}).catch(function(){status.textContent='Could not load comments.'})}document.addEventListener('selectionchange',showTrigger);trigger.addEventListener('click',function(){var range=activeRange();trigger.hidden=true;if(range)select(range)});document.querySelector('.wb-comment-close').addEventListener('click',function(){rail.hidden=true;selected=null});form.addEventListener('submit',function(event){event.preventDefault();if(!selected)return;var body=document.getElementById('wb-comment-body').value.trim();if(!body)return;var button=form.querySelector('button');button.disabled=true;status.textContent='Sending…';fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({author:document.getElementById('wb-comment-name').value.trim()||'Coworker',body:body,version:version,anchor:selected.anchor})}).then(function(response){if(!response.ok)throw new Error();return response.json()}).then(function(payload){comments.push(payload.comment);document.getElementById('wb-comment-body').value='';status.textContent='Comment added.';highlight();render()}).catch(function(){status.textContent='Could not send that. Try again.'}).finally(function(){button.disabled=false})});load()})();</script>`;
}

function injectFooter(page: string, footer: string): string {
  if (!footer) return page;
  return /<\/body>/i.test(page) ? page.replace(/<\/body>/i, `${footer}</body>`) : `${page}${footer}`;
}

/** Adds Workbench-owned feedback chrome to an already-published page. */
export function addFeedbackToPublishedPage(page: string, feedback: NonNullable<ArtifactPageOptions['feedback']>): string {
  if (page.includes('data-wb-commenting')) return page;
  const withoutLegacyForm = page.replace(/<form id="wb-feedback">[\s\S]*?<\/form><script>[\s\S]*?<\/script>/, '');
  const layer = renderCommentingLayer(feedback, 1);
  const withLayer = /<footer class="wb-artifact-meta">/i.test(withoutLegacyForm)
    ? withoutLegacyForm.replace(/<\/footer>/i, `</footer>${layer}`)
    : injectFooter(withoutLegacyForm, renderPageFooter({ feedback }));
  const withConnection = withLayer.replace(/connect-src 'none'/g, `connect-src ${feedback.endpointOrigin}`);
  return /script-src[^;]*'unsafe-inline'/.test(withConnection)
    ? withConnection
    : withConnection.replace(/style-src ([^;]+);/i, "style-src $1; script-src 'unsafe-inline';");
}

export function renderArtifactPage(sourcePath: string, title: string, options: ArtifactPageOptions = {}): string {
  return renderArtifactContent(readFileSync(sourcePath, 'utf8'), extname(sourcePath).toLowerCase(), title, options);
}

function renderArtifactContent(source: string, extension: string, title: string, options: ArtifactPageOptions = {}): string {
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
    const commentTarget = options.feedback && !/<main(?:\s[^>]*)?>/i.test(page)
      ? page.replace(/<body(\s[^>]*)?>/i, '$&<main data-wb-comment-root>').replace(/<\/body>/i, '</main></body>')
      : page;
    return injectFooter(commentTarget, footer);
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

type SnapshotRepair = { restored: Array<{ id: string; version: number }>; missing: Array<{ id: string; version: number }> };

function storedPage(path: string): string | null {
  try {
    const content = readFileSync(path, 'utf8');
    return content ? content : null;
  } catch { return null; }
}

function artifactDirectory(outputDirectory: string, id: string): string | null {
  // IDs are generated as base64url. Keep a corrupt database row from turning a
  // recovery read into a path outside the artifact output root.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return resolve(outputDirectory, id);
}

/**
 * Last-resort recovery for a historical page omitted from the local deployment
 * directory. Git content is accepted only when rendering it produces the exact
 * hash recorded at publication; mutable working-tree files are never used.
 */
function historicalGitSnapshot(sourcePath: string, title: string, expectedHash?: string): string | null {
  if (!expectedHash || !existsSync(sourcePath)) return null;
  try {
    const sourceDirectory = dirname(sourcePath);
    const repository = execFileSync('git', ['-C', sourceDirectory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5_000 }).trim();
    const repositoryPath = relative(repository, sourcePath);
    if (!repository || repositoryPath.startsWith('..')) return null;
    const revisions = execFileSync('git', ['-C', repository, 'log', '--format=%H', '--all', '--', repositoryPath], { encoding: 'utf8', timeout: 5_000, maxBuffer: 1_000_000 })
      .trim().split('\n').filter(Boolean);
    for (const revision of revisions) {
      const source = execFileSync('git', ['-C', repository, 'show', `${revision}:${repositoryPath}`], { encoding: 'utf8', timeout: 5_000, maxBuffer: 2_000_000 });
      const page = renderArtifactContent(source, extname(sourcePath).toLowerCase(), title);
      if (createHash('sha256').update(page).digest('hex') === expectedHash) return page;
    }
  } catch { /* Git history is optional recovery material. */ }
  return null;
}

/**
 * Repairs rows created before rendered snapshots were persisted. The existing
 * deployment directory is evidence of the exact public page, so it is imported
 * verbatim. A historical Git reconstruction is accepted only after a hash
 * check against the version record. Missing pages are intentionally reported,
 * never regenerated from a mutable source checkout.
 */
export function repairLegacyArtifactSnapshots(
  outputDirectory: string,
  live: LiveArtifact[],
  record: (artifactId: string, version: number, content: string) => boolean,
): SnapshotRepair {
  const result: SnapshotRepair = { restored: [], missing: [] };
  for (const artifact of live) {
    const directory = artifactDirectory(outputDirectory, artifact.id);
    for (const snapshot of artifact.snapshots) {
      if (snapshot.content) continue;
      const versionPath = directory && resolve(directory, `v${snapshot.version}`, 'index.html');
      const currentPath = snapshot.version === artifact.version && directory ? resolve(directory, 'index.html') : null;
      const content = (versionPath && storedPage(versionPath))
        ?? (currentPath && storedPage(currentPath))
        ?? historicalGitSnapshot(artifact.sourcePath, artifact.title, snapshot.contentHash);
      if (content && record(artifact.id, snapshot.version, content)) result.restored.push({ id: artifact.id, version: snapshot.version });
      else result.missing.push({ id: artifact.id, version: snapshot.version });
    }
  }
  return result;
}

/**
 * Cloudflare Pages deploys are whole-directory snapshots: every `wrangler
 * pages deploy` replaces the entire prior production deployment with exactly
 * what's on disk (there is no partial/incremental production update). So the
 * only way to stop one publish or revoke from silently dropping every other
 * previously-shared link is to make sure `outputDirectory` matches what the
 * DB considers live before every deploy — not trust whatever happens to be
 * on disk (which is gitignored and won't exist on a fresh checkout).
 *
 * This regenerates any live artifact's page from its stored source file when
 * the directory is missing it. Artifacts whose source file is also gone
 * can't be reconstructed; those ids come back in `missing` so the caller can
 * refuse to deploy rather than silently taking them offline.
 */
export function reconcileArtifactDirectory(outputDirectory: string, live: LiveArtifact[]): { restored: string[]; missing: string[] } {
  const restored: string[] = [];
  const missing: string[] = [];
  // The directory is a deploy artifact, never a source of truth. Rebuild it
  // from the immutable manifest so an orphan from a failed/old operation is
  // neither carried into the next whole-directory deploy nor made public.
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  for (const artifact of live) {
    const artifactDirectory = resolve(outputDirectory, artifact.id);
    const current = artifact.snapshots.find((snapshot) => snapshot.version === artifact.version);
    if (!current?.content || artifact.snapshots.some((snapshot) => !snapshot.content && !isPreVersionedHistoricalSnapshot(artifact, snapshot))) {
      missing.push(artifact.id);
      continue;
    }
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(resolve(artifactDirectory, 'index.html'), current.content);
    for (const snapshot of artifact.snapshots) {
      const content = snapshot.content;
      if (!content) continue; // validated above; keeps the file-write input narrow.
      const versionDirectory = resolve(artifactDirectory, `v${snapshot.version}`);
      mkdirSync(versionDirectory, { recursive: true });
      writeFileSync(resolve(versionDirectory, 'index.html'), content);
    }
    restored.push(artifact.id);
  }
  return { restored, missing };
}

/** Bounded check that a revoked artifact's public URL actually stopped serving. Best-effort: a network error or non-404 status is reported as unverified rather than assumed safe. */
export async function verifyRevoked(url: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return response.status === 404;
  } catch {
    return false;
  }
}

export class CloudflarePagesPublisher implements ArtifactPublisher {
  private readonly outputDirectory = resolve(process.env.ARTIFACT_OUTPUT_DIRECTORY ?? 'data/published');
  private readonly project = process.env.ARTIFACT_PAGES_PROJECT?.trim();
  private readonly baseUrl = process.env.ARTIFACT_PUBLIC_BASE_URL?.trim().replace(/\/$/, '');

  private configuration(): { project: string; baseUrl: string } {
    if (!this.project || !this.baseUrl) throw new Error('Artifact publishing is not configured. Set ARTIFACT_PAGES_PROJECT and ARTIFACT_PUBLIC_BASE_URL.');
    return { project: this.project, baseUrl: this.baseUrl };
  }

  private async deploy(directory = this.outputDirectory): Promise<void> {
    const { project } = this.configuration();
    recordAudit('outbound_call', 'cloudflare', `wrangler pages deploy --project-name ${project}`);
    await execFileAsync('npx', ['--yes', 'wrangler', 'pages', 'deploy', directory, '--project-name', project, '--branch', 'main', '--commit-dirty=true'], {
      env: process.env, timeout: 120_000, maxBuffer: 2_000_000,
    });
    await this.pruneOldDeployments(project);
  }

  private async pruneOldDeployments(project: string): Promise<void> {
    recordAudit('outbound_call', 'cloudflare', `wrangler pages deployment list --project-name ${project}`);
    const { stdout } = await execFileAsync('npx', ['--yes', 'wrangler', 'pages', 'deployment', 'list', '--project-name', project, '--json'], {
      env: process.env, timeout: 30_000, maxBuffer: 2_000_000,
    });
    const deployments = JSON.parse(stdout) as Array<{ Id: string; Environment: string }>;
    const production = deployments.filter((entry) => entry.Environment === 'Production');
    for (const deployment of production.slice(1)) {
      try {
        recordAudit('outbound_call', 'cloudflare', `wrangler pages deployment delete ${deployment.Id} --project-name ${project}`);
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
  async publish(input: PublishInput, live: LiveArtifact[]): Promise<PublishedArtifact> {
    const { baseUrl } = this.configuration();
    const stagingDirectory = resolve(dirname(this.outputDirectory), `.published-stage-${randomBytes(8).toString('hex')}`);
    rmSync(stagingDirectory, { recursive: true, force: true });
    const { missing } = reconcileArtifactDirectory(stagingDirectory, live.filter((artifact) => artifact.id !== input.id));
    if (missing.length) throw new Error(`Cannot publish: ${missing.length} previously published artifact version(s) have no immutable rendered snapshot (${missing.join(', ')}). Deploying now would take those links offline.`);
    const artifactDirectory = resolve(stagingDirectory, input.id);
    const versionDirectory = resolve(artifactDirectory, `v${input.version}`);
    mkdirSync(versionDirectory, { recursive: true });
    writeFileSync(resolve(artifactDirectory, 'index.html'), input.renderedContent);
    writeFileSync(resolve(versionDirectory, 'index.html'), input.renderedContent);
    await this.deploy(stagingDirectory);
    rmSync(this.outputDirectory, { recursive: true, force: true });
    renameSync(stagingDirectory, this.outputDirectory);
    return { id: input.id, title: input.title, url: `${baseUrl}/${input.id}/` };
  }

  async refreshFeedback(live: LiveArtifact[], feedback: NonNullable<ArtifactPageOptions['feedback']>): Promise<number> {
    this.configuration();
    const stagingDirectory = resolve(dirname(this.outputDirectory), `.published-stage-${randomBytes(8).toString('hex')}`);
    rmSync(stagingDirectory, { recursive: true, force: true });
    const { missing } = reconcileArtifactDirectory(stagingDirectory, live);
    if (missing.length) throw new Error(`Cannot enable artifact feedback: ${missing.length} published artifact version(s) have no immutable rendered snapshot (${missing.join(', ')}).`);
    let refreshed = 0;
    for (const artifact of live) {
      for (const snapshot of artifact.snapshots) {
        if (!snapshot.content) continue;
        const page = addFeedbackToPublishedPage(snapshot.content, { ...feedback, artifactId: artifact.id });
        if (page === snapshot.content) continue;
        writeFileSync(resolve(stagingDirectory, artifact.id, `v${snapshot.version}`, 'index.html'), page);
        if (snapshot.version === artifact.version) writeFileSync(resolve(stagingDirectory, artifact.id, 'index.html'), page);
        refreshed += 1;
      }
    }
    if (refreshed > 0) {
      await this.deploy(stagingDirectory);
      rmSync(this.outputDirectory, { recursive: true, force: true });
      renameSync(stagingDirectory, this.outputDirectory);
    } else {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
    return refreshed;
  }

  versionUrl(id: string, version: number): string {
    return `${this.configuration().baseUrl}/${id}/v${version}/`;
  }

  publicUrl(id: string): string {
    return `${this.configuration().baseUrl}/${id}/`;
  }

  /**
   * `live` must be read from the DB after the caller has already marked this
   * id revoked there, so the query naturally excludes it and this method
   * only has to remove `id`'s own directory and restore anything else that's
   * still supposed to be live.
   */
  async revoke(id: string, live: LiveArtifact[], publicUrl: string): Promise<{ verified: boolean }> {
    this.configuration();
    const stagingDirectory = resolve(dirname(this.outputDirectory), `.published-stage-${randomBytes(8).toString('hex')}`);
    rmSync(stagingDirectory, { recursive: true, force: true });
    const { missing } = reconcileArtifactDirectory(stagingDirectory, live);
    if (missing.length) throw new Error(`Cannot revoke: ${missing.length} other published artifact version(s) have no immutable rendered snapshot (${missing.join(', ')}). Deploying now would take those links offline.`);
    await this.deploy(stagingDirectory);
    rmSync(this.outputDirectory, { recursive: true, force: true });
    renameSync(stagingDirectory, this.outputDirectory);
    return { verified: await verifyRevoked(publicUrl) };
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
