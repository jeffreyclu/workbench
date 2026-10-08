import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ObservedRunEvent } from './review-handoff.js';
import { WORKBENCH_DOCUMENTS_ROOT } from './local-documents.js';

/** Publishes one file; resolves with whether a new version actually went out. */
export type RunArtifactPublisher = (input: { path: string; workItemId: string; conversationId: string | null }) => Promise<{ published: boolean; title?: string }>;

let publisher: RunArtifactPublisher | null = null;

/** Registered once by createApp; absent in unit tests so a run never deploys. */
export function setRunArtifactPublisher(next: RunArtifactPublisher | null): void {
  publisher = next;
}

const EXCLUDED_SEGMENTS = new Set(['node_modules', 'fixtures', '__fixtures__', 'test-fixtures']);

function inside(root: string, path: string): string | null {
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
}

/**
 * Markdown a run wrote that belongs in the artifact library: `.md` files under
 * `docs/` of a run worktree, or anywhere under ~/Documents/Workbench. Paths in
 * node_modules or test fixtures are skipped.
 */
export function collectRunMarkdownPaths(events: ObservedRunEvent[], workspaces: string[], documentsRoot = WORKBENCH_DOCUMENTS_ROOT): string[] {
  const roots = workspaces.filter(Boolean).map((workspace) => resolve(workspace));
  const found = new Set<string>();
  for (const event of events) {
    if (event.category !== 'agent_file_write') continue;
    const raw = event.detail.replace(/^\[[^\]]+\]\s*/, '').replace(/^(?:add|create|update):\s*/i, '').trim();
    if (!raw || raw.includes('\n') || /^delete:/i.test(raw) || !/\.md$/i.test(raw)) continue;
    const candidates = isAbsolute(raw) ? [resolve(raw)] : roots.map((root) => resolve(root, raw));
    for (const path of candidates) {
      const inDocuments = inside(documentsRoot, path);
      const inWorkspaceDocs = roots.some((root) => inside(resolve(root, 'docs'), path));
      const rel = inDocuments ?? roots.map((root) => inside(root, path)).find(Boolean) ?? null;
      if (!(inDocuments || inWorkspaceDocs) || !rel) continue;
      if (rel.split(sep).some((segment) => EXCLUDED_SEGMENTS.has(segment))) continue;
      found.add(path);
      break;
    }
  }
  return [...found];
}

/**
 * Publishes every qualifying markdown file the run wrote and records one
 * activity entry per new version. Unchanged content is a no-op in the
 * publisher, so a repeated run adds nothing. Failures never fail the run.
 */
export async function publishRunMarkdown(
  input: { events: ObservedRunEvent[]; workspaces: string[]; workItemId: string; conversationId: string | null },
  addActivity: (message: string) => void,
  publish: RunArtifactPublisher | null = publisher,
  documentsRoot?: string,
): Promise<string[]> {
  if (!publish) return [];
  const published: string[] = [];
  for (const path of collectRunMarkdownPaths(input.events, input.workspaces, documentsRoot)) {
    try {
      const result = await publish({ path, workItemId: input.workItemId, conversationId: input.conversationId });
      if (!result.published) continue;
      published.push(path);
      addActivity(`Published ${basename(path)} to the artifact library.`);
    } catch (error) {
      console.error(`Auto-publish of ${path} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return published;
}
