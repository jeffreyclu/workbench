import type { ResolvedSourceDraft } from '../shared/contracts.js';
import { resolveSlackPermalinkWithCodex } from './slack-codex.js';
import { createOutboundFetch, OutboundPolicyError, type OutboundPolicyName } from './outbound-policy.js';

function sourceFor(host: string): string {
  if (host === 'claude.ai') return 'Claude';
  if (host === 'github.com') return 'GitHub';
  if (host === 'slack.com' || host.endsWith('.slack.com')) return 'Slack';
  if (host === 'atlassian.net' || host.endsWith('.atlassian.net')) return 'Confluence';
  if (host === 'mail.google.com') return 'Gmail';
  if (host === 'linear.app' || host.endsWith('.linear.app')) return 'Linear';
  return host;
}

function plainText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
}

function adfText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as { text?: unknown; content?: unknown[]; type?: unknown };
  const own = typeof node.text === 'string' ? node.text : '';
  const children = Array.isArray(node.content) ? node.content.map(adfText).join('') : '';
  return own + children + (node.type === 'paragraph' || node.type === 'heading' ? '\n' : '');
}

async function resolveAtlassian(url: URL, settings: Record<string, string> | null, fetchImpl: typeof fetch): Promise<ResolvedSourceDraft> {
  if (!settings?.siteUrl || !settings.email || !settings.token) {
    const draft = fallback(url, 'Confluence');
    return { ...draft, description: `Connect Confluence in Workbench Sources to import this Atlassian page.\n\n${url}` };
  }
  const site = settings.siteUrl.replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${settings.email}:${settings.token}`).toString('base64')}`;
  const pageId = url.pathname.match(/\/pages\/(\d+)/)?.[1] ?? url.searchParams.get('pageId');
  const issueKey = url.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i)?.[1];
  const endpoint = pageId ? `${site}/wiki/rest/api/content/${pageId}?expand=body.storage,space,version`
    : issueKey ? `${site}/rest/api/3/issue/${issueKey}` : null;
  if (!endpoint) return fallback(url, 'Atlassian');
  const response = await fetchImpl(endpoint, { headers: { Accept: 'application/json', Authorization: auth }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Atlassian could not resolve this link (${response.status}). Check the Confluence connection in Sources.`);
  if (pageId) {
    const page = await response.json() as { title?: string; body?: { storage?: { value?: string } }; space?: { name?: string }; version?: { number?: number } };
    const body = plainText(page.body?.storage?.value ?? '');
    return { source: 'Confluence', sourceUrl: url.toString(), title: page.title || `Confluence page ${pageId}`,
      description: [`Confluence${page.space?.name ? ` · ${page.space.name}` : ''}${page.version?.number ? ` · version ${page.version.number}` : ''}`, body].filter(Boolean).join('\n\n').slice(0, 30_000) };
  }
  const issue = await response.json() as { key?: string; fields?: { summary?: string; description?: unknown; status?: { name?: string }; project?: { name?: string } } };
  const body = adfText(issue.fields?.description).trim();
  return { source: 'Atlassian', sourceUrl: url.toString(), title: issue.fields?.summary || issue.key || issueKey!,
    description: [`${issue.key ?? issueKey}${issue.fields?.project?.name ? ` · ${issue.fields.project.name}` : ''}${issue.fields?.status?.name ? ` · ${issue.fields.status.name}` : ''}`, body].filter(Boolean).join('\n\n').slice(0, 30_000) };
}

function fallback(url: URL, source: string): ResolvedSourceDraft {
  const readable = decodeURIComponent(url.pathname).split('/').filter(Boolean).at(-1)?.replace(/[-_]/g, ' ') ?? source;
  return { source, sourceUrl: url.toString(), title: readable, description: `Context from ${source}: ${url.toString()}` };
}

export async function resolveSourceUrl(value: string, options: { confluenceSettings?: Record<string, string> | null; githubSettings?: Record<string, string> | null; fetchForPolicy?: (policy: OutboundPolicyName) => typeof fetch } = {}): Promise<ResolvedSourceDraft> {
  const url = new URL(value);
  const source = sourceFor(url.hostname);
  const fetchFor = options.fetchForPolicy ?? createOutboundFetch;
  if (source === 'Claude' && /^\/code\/artifact\/[0-9a-f-]+/i.test(url.pathname)) {
    const artifactId = url.pathname.split('/').filter(Boolean).at(-1)!;
    return { source, sourceUrl: url.toString(), title: `Claude artifact ${artifactId.slice(0, 8)}`,
      description: `Private Claude artifact. Workbench cannot read its authenticated browser frame from this URL. Open the artifact, copy its relevant contents into this description, or create a public share link that includes an sk share key.\n\n${url}` };
  }
  if (url.hostname === 'atlassian.net' || url.hostname.endsWith('.atlassian.net')) return resolveAtlassian(url, options.confluenceSettings ?? null, fetchFor('atlassian-api'));
  if (source === 'Slack') return resolveSlackPermalinkWithCodex(url.toString());
  if (source === 'GitHub') {
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
    if (match) {
      const endpoint = `https://api.github.com/repos/${match[1]}/${match[2]}/issues/${match[4]}`;
      const githubToken = options.githubSettings?.token ?? process.env.GITHUB_TOKEN;
      const response = await fetchFor('github-api')(endpoint, { headers: {
        Accept: 'application/vnd.github+json', 'User-Agent': 'workbench-local',
        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
      } });
      if (response.ok) {
        const issue = await response.json() as { title: string; body: string | null; html_url: string };
        return { source, sourceUrl: issue.html_url, title: issue.title, description: issue.body?.trim() || `GitHub ${match[3]} #${match[4]} in ${match[1]}/${match[2]}.` };
      }
    }
  }
  try {
    const response = await fetchFor('source-page')(url, { signal: AbortSignal.timeout(8_000) });
    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      const html = await response.text();
      const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
      const description = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i)?.[1]?.trim();
      if (title) return { source, sourceUrl: url.toString(), title, description: description || `Context from ${source}: ${url.toString()}` };
    }
  } catch (error) {
    // A policy rejection is input validation, not an inaccessible page. Let the
    // route return its stable 400 response instead of hiding it behind a draft.
    if (error instanceof OutboundPolicyError) throw error;
    // Authentication-only pages fall back to an editable local draft.
  }
  return fallback(url, source);
}
