import type { ResolvedSourceDraft } from '../shared/contracts.js';
import { resolveSlackPermalinkWithCodex } from './slack-codex.js';

function sourceFor(host: string): string {
  if (host === 'github.com') return 'GitHub';
  if (host.includes('slack.com')) return 'Slack';
  if (host.includes('atlassian.net')) return 'Confluence';
  if (host === 'mail.google.com') return 'Gmail';
  if (host.includes('linear.app')) return 'Linear';
  return host;
}

function fallback(url: URL, source: string): ResolvedSourceDraft {
  const readable = decodeURIComponent(url.pathname).split('/').filter(Boolean).at(-1)?.replace(/[-_]/g, ' ') ?? source;
  return { source, sourceUrl: url.toString(), title: readable, description: `Context from ${source}: ${url.toString()}` };
}

export async function resolveSourceUrl(value: string): Promise<ResolvedSourceDraft> {
  const url = new URL(value);
  const source = sourceFor(url.hostname);
  if (source === 'Slack') return resolveSlackPermalinkWithCodex(url.toString());
  if (source === 'GitHub') {
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
    if (match) {
      const endpoint = `https://api.github.com/repos/${match[1]}/${match[2]}/issues/${match[4]}`;
      const response = await fetch(endpoint, { headers: {
        Accept: 'application/vnd.github+json', 'User-Agent': 'workbench-local',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      } });
      if (response.ok) {
        const issue = await response.json() as { title: string; body: string | null; html_url: string };
        return { source, sourceUrl: issue.html_url, title: issue.title, description: issue.body?.trim() || `GitHub ${match[3]} #${match[4]} in ${match[1]}/${match[2]}.` };
      }
    }
  }
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8_000) });
    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      const html = await response.text();
      const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
      const description = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i)?.[1]?.trim();
      if (title) return { source, sourceUrl: url.toString(), title, description: description || `Context from ${source}: ${url.toString()}` };
    }
  } catch { /* Authentication-only pages fall back to an editable local draft. */ }
  return fallback(url, source);
}
