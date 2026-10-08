import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';

import type { WorkbenchDatabase } from './database.js';
import { publishRealtimeEvent, publishRealtimeMessagesEvent } from './realtime.js';
import { projectKey } from '../shared/project-name.js';
import { isManagedRunWorktree } from './run-worktree.js';

/**
 * Mirrors Claude Code and Codex sessions that Jeffrey starts in a terminal
 * into Workbench conversations. Each transcript file is read from its last
 * imported byte, so a running session keeps updating one conversation.
 * Workbench's own provider runs write to the same directories and are
 * skipped by origin, working directory, or a session id Workbench owns.
 */

export type TerminalProvider = 'claude' | 'codex';

export type TranscriptEntry =
  | { kind: 'prompt'; text: string; at: string }
  | { kind: 'reply'; text: string; at: string }
  | { kind: 'tool'; at: string };

export type ParsedTranscriptLine = {
  /** Where the session came from, present on every line that can decide it. */
  session?: { cwd: string | null; origin: 'terminal' | 'workbench' };
  entries: TranscriptEntry[];
};

export type TerminalSessionSyncOptions = {
  claudeProjectsRoot?: string;
  codexSessionsRoot?: string;
  /** A transcript untouched for longer than this is never imported, and a
   * newly seen session imports only the turns inside this window. */
  lookbackMs?: number;
  now?: () => number;
};

export type TerminalSessionSyncResult = {
  createdConversationIds: string[];
  updatedConversationIds: string[];
};

const DEFAULT_LOOKBACK_HOURS = 24;
const CHUNK_BYTES = 4 * 1024 * 1024;
const RESCAN_MS = 15_000;
const WATCH_DEBOUNCE_MS = 300;
const TITLE_LENGTH = 80;

export function defaultTerminalSyncLookbackMs(): number {
  const hours = Number(process.env.WORKBENCH_TERMINAL_SYNC_LOOKBACK_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LOOKBACK_HOURS) * 3_600_000;
}

function resolveOptions(options: TerminalSessionSyncOptions) {
  return {
    claudeProjectsRoot: options.claudeProjectsRoot ?? join(homedir(), '.claude', 'projects'),
    codexSessionsRoot: options.codexSessionsRoot ?? join(homedir(), '.codex', 'sessions'),
    lookbackMs: options.lookbackMs ?? defaultTerminalSyncLookbackMs(),
    now: options.now ?? Date.now,
  };
}

// ---------------------------------------------------------------------------
// Transcript parsing

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try { return asRecord(JSON.parse(line)); } catch { return null; }
}

function timestampOf(record: Record<string, unknown>): string {
  const parsed = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

/** Text the CLI injects into the user role (AGENTS.md, environment context,
 * slash-command echoes, interrupt markers) rather than anything Jeffrey typed. */
export function isInjectedContext(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('# AGENTS.md instructions for ')) return true;
  if (trimmed.startsWith('[Request interrupted by user')) return true;
  return trimmed.startsWith('<') && trimmed.endsWith('>') && trimmed.indexOf('>') > 1 && trimmed.lastIndexOf('</') > 0;
}

function typedText(texts: string[]): string {
  return texts.filter((text) => !isInjectedContext(text)).map((text) => text.trim()).filter(Boolean).join('\n\n');
}

export function parseClaudeTranscriptLine(line: string): ParsedTranscriptLine | null {
  const record = parseJsonLine(line);
  if (!record || (record.type !== 'user' && record.type !== 'assistant')) return null;
  // Subagent turns belong to the parent turn, not to the conversation.
  if (record.isSidechain === true) return null;
  const at = timestampOf(record);
  // Interactive sessions are "cli" (or an IDE entrypoint); every `claude -p`
  // Workbench spawns is "sdk-cli", including runs outside a run worktree.
  const entrypoint = typeof record.entrypoint === 'string' ? record.entrypoint : '';
  const session = { cwd: typeof record.cwd === 'string' ? record.cwd : null, origin: entrypoint.startsWith('sdk') ? 'workbench' as const : 'terminal' as const };
  const content = asRecord(record.message)?.content;
  const items = Array.isArray(content) ? content.map(asRecord).filter((item): item is Record<string, unknown> => item !== null) : [];

  if (record.type === 'user') {
    if (record.isMeta === true || record.isCompactSummary === true) return { session, entries: [] };
    if (items.some((item) => item.type === 'tool_result')) return { session, entries: [] };
    const texts = typeof content === 'string' ? [content] : items.filter((item) => item.type === 'text').map((item) => String(item.text ?? ''));
    const text = typedText(texts);
    return { session, entries: text ? [{ kind: 'prompt', text, at }] : [] };
  }

  if (typeof content === 'string') return { session, entries: content.trim() ? [{ kind: 'reply', text: content.trim(), at }] : [] };
  const entries: TranscriptEntry[] = [];
  for (const item of items) {
    if (item.type === 'text' && String(item.text ?? '').trim()) entries.push({ kind: 'reply', text: String(item.text).trim(), at });
    else if (item.type === 'tool_use') entries.push({ kind: 'tool', at });
  }
  return { session, entries };
}

export function parseCodexTranscriptLine(line: string): ParsedTranscriptLine | null {
  const record = parseJsonLine(line);
  const payload = record ? asRecord(record.payload) : null;
  if (!record || !payload) return null;
  if (record.type === 'session_meta') {
    return { session: { cwd: typeof payload.cwd === 'string' ? payload.cwd : null, origin: payload.originator === 'workbench' ? 'workbench' : 'terminal' }, entries: [] };
  }
  if (record.type !== 'response_item') return null;
  const at = timestampOf(record);
  // Reasoning and tool output are noise here; a call counts as tool activity.
  if (typeof payload.type === 'string' && payload.type.endsWith('_call')) return { entries: [{ kind: 'tool', at }] };
  if (payload.type !== 'message') return null;
  const items = Array.isArray(payload.content) ? payload.content.map(asRecord).filter((item): item is Record<string, unknown> => item !== null) : [];
  if (payload.role === 'user') {
    const text = typedText(items.filter((item) => item.type === 'input_text').map((item) => String(item.text ?? '')));
    return { entries: text ? [{ kind: 'prompt', text, at }] : [] };
  }
  if (payload.role === 'assistant') {
    const text = items.filter((item) => item.type === 'output_text').map((item) => String(item.text ?? '').trim()).filter(Boolean).join('\n\n');
    return { entries: text ? [{ kind: 'reply', text, at }] : [] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transcript discovery and reading

type TranscriptFile = { path: string; provider: TerminalProvider; sessionId: string; mtimeMs: number; size: number };

const CODEX_THREAD_ID_LENGTH = 36;

/** Only top-level session files count: Claude subagent transcripts live in a
 * directory named after the parent session and are deliberately ignored. */
function classifyTranscriptPath(path: string, roots: ReturnType<typeof resolveOptions>): Omit<TranscriptFile, 'mtimeMs' | 'size'> | null {
  if (!path.endsWith('.jsonl')) return null;
  const claudeRelative = relative(roots.claudeProjectsRoot, path);
  if (!claudeRelative.startsWith('..') && claudeRelative.split(sep).length === 2) {
    return { path, provider: 'claude', sessionId: basename(path, '.jsonl') };
  }
  const codexRelative = relative(roots.codexSessionsRoot, path);
  const name = basename(path, '.jsonl');
  if (!codexRelative.startsWith('..') && name.startsWith('rollout-') && name.length > CODEX_THREAD_ID_LENGTH) {
    return { path, provider: 'codex', sessionId: name.slice(-CODEX_THREAD_ID_LENGTH) };
  }
  return null;
}

async function listJsonl(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true });
    return entries.filter((entry) => entry.endsWith('.jsonl')).map((entry) => join(root, entry));
  } catch {
    return [];
  }
}

async function statTranscripts(paths: string[], roots: ReturnType<typeof resolveOptions>): Promise<TranscriptFile[]> {
  const candidates = paths.map((path) => classifyTranscriptPath(path, roots)).filter((file) => file !== null);
  const files: TranscriptFile[] = [];
  for (let index = 0; index < candidates.length; index += 64) {
    const batch = await Promise.all(candidates.slice(index, index + 64).map(async (file) => {
      try {
        const info = await stat(file.path);
        return info.isFile() ? { ...file, mtimeMs: info.mtimeMs, size: info.size } : null;
      } catch {
        return null;
      }
    }));
    files.push(...batch.filter((file) => file !== null));
  }
  return files;
}

/** Reads whole lines from `offset`. A trailing partial line stays unread until
 * the writer finishes it, so `nextOffset` always lands just after a newline. */
async function readCompleteLines(path: string, offset: number): Promise<{ lines: string[]; nextOffset: number; size: number }> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= offset) return { lines: [], nextOffset: offset, size };
    let length = Math.min(CHUNK_BYTES, size - offset);
    for (;;) {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const lastNewline = bytesRead > 0 ? buffer.lastIndexOf(0x0a, bytesRead - 1) : -1;
      if (lastNewline >= 0) {
        return { lines: buffer.subarray(0, lastNewline).toString('utf8').split('\n'), nextOffset: offset + lastNewline + 1, size };
      }
      // One line longer than the chunk: widen the read until it ends.
      if (offset + bytesRead >= size) return { lines: [], nextOffset: offset, size };
      length = Math.min(length * 2, size - offset);
    }
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Import ledger

type ImportRow = {
  transcriptPath: string;
  provider: TerminalProvider;
  sessionId: string;
  status: 'pending' | 'terminal' | 'skipped';
  skipReason: string | null;
  cwd: string | null;
  conversationId: string | null;
  byteOffset: number;
  importSince: string;
  replyMessageId: string | null;
  replyText: string;
  replyToolCount: number;
  createdAt: string;
};

function mapImportRow(row: Record<string, unknown>): ImportRow {
  return {
    transcriptPath: String(row.transcript_path), provider: row.provider as TerminalProvider, sessionId: String(row.session_id),
    status: row.status as ImportRow['status'], skipReason: row.skip_reason ? String(row.skip_reason) : null, cwd: row.cwd ? String(row.cwd) : null,
    conversationId: row.conversation_id ? String(row.conversation_id) : null, byteOffset: Number(row.byte_offset), importSince: String(row.import_since),
    replyMessageId: row.reply_message_id ? String(row.reply_message_id) : null, replyText: String(row.reply_text ?? ''), replyToolCount: Number(row.reply_tool_count ?? 0),
    createdAt: String(row.created_at),
  };
}

function readImportRow(database: WorkbenchDatabase, path: string): ImportRow | null {
  const row = database.prepare('SELECT * FROM terminal_session_imports WHERE transcript_path = ?').get(path) as Record<string, unknown> | undefined;
  return row ? mapImportRow(row) : null;
}

function writeImportRow(database: WorkbenchDatabase, row: ImportRow, now: string): void {
  database.prepare(`
    INSERT INTO terminal_session_imports (transcript_path, provider, session_id, status, skip_reason, cwd, conversation_id, byte_offset, import_since, reply_message_id, reply_text, reply_tool_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transcript_path) DO UPDATE SET
      status = excluded.status, skip_reason = excluded.skip_reason, cwd = excluded.cwd, conversation_id = excluded.conversation_id,
      byte_offset = excluded.byte_offset, reply_message_id = excluded.reply_message_id, reply_text = excluded.reply_text,
      reply_tool_count = excluded.reply_tool_count, updated_at = excluded.updated_at
  `).run(row.transcriptPath, row.provider, row.sessionId, row.status, row.skipReason, row.cwd, row.conversationId, row.byteOffset, row.importSince, row.replyMessageId, row.replyText, row.replyToolCount, row.createdAt, now);
}

/** Provider sessions Workbench itself started or resumes; never re-imported. */
function loadOwnedSessionIds(database: WorkbenchDatabase): Record<TerminalProvider, Set<string>> {
  const claude = database.prepare(`
    SELECT claude_session_id AS id FROM shared_conversations WHERE claude_session_id IS NOT NULL
    UNION SELECT provider_session_id FROM agent_sessions WHERE agent = 'claude' AND provider_session_id IS NOT NULL
  `).all() as Array<{ id: string }>;
  const codex = database.prepare(`
    SELECT codex_thread_id AS id FROM shared_conversations WHERE codex_thread_id IS NOT NULL
    UNION SELECT provider_session_id FROM agent_sessions WHERE agent = 'codex' AND provider_session_id IS NOT NULL
  `).all() as Array<{ id: string }>;
  return { claude: new Set(claude.map((row) => row.id)), codex: new Set(codex.map((row) => row.id)) };
}

// ---------------------------------------------------------------------------
// Applying parsed lines

const PROVIDER_LABEL: Record<TerminalProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

function titleFromPrompt(text: string): string {
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) ?? 'Terminal session';
  return firstLine.slice(0, TITLE_LENGTH);
}

function replyBody(text: string, toolCount: number): string {
  if (!toolCount) return text;
  const activity = `_${toolCount} tool call${toolCount === 1 ? '' : 's'} in the terminal session._`;
  return text ? `${text}\n\n${activity}` : activity;
}

type ChunkChanges = { created: Set<string>; updated: Set<string> };

function syncMarker(provider: TerminalProvider, sessionId: string, cwd: string | null, project: string | null = null): string {
  const where = cwd ? ` in \`${cwd}\`` : '';
  const linked = project ? ` Project: ${project}.` : '';
  return `Synced from a terminal ${PROVIDER_LABEL[provider]} session${where} (session \`${sessionId}\`).${linked} New turns from the terminal appear here automatically.`;
}

function insertMessage(database: WorkbenchDatabase, conversationId: string, author: 'jeffrey' | 'system' | TerminalProvider, body: string, at: string): string {
  const id = randomUUID();
  database.prepare(`
    INSERT INTO shared_messages (id, conversation_id, author, body, pinned, status, error, attachments_json, dispatch_target, created_at, completed_at)
    VALUES (?, ?, ?, ?, 0, 'completed', '', '[]', 'none', ?, ?)
  `).run(id, conversationId, author, body, at, at);
  database.prepare('UPDATE shared_conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?').run(at, conversationId);
  return id;
}

function applyEntry(database: WorkbenchDatabase, row: ImportRow, entry: TranscriptEntry, changes: ChunkChanges): void {
  if (entry.at < row.importSince) return;
  if (entry.kind === 'prompt') {
    if (!row.conversationId) {
      const conversationId = randomUUID();
      database.prepare('INSERT INTO shared_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(conversationId, titleFromPrompt(entry.text), entry.at, entry.at);
      insertMessage(database, conversationId, 'system', syncMarker(row.provider, row.sessionId, row.cwd), entry.at);
      row.conversationId = conversationId;
      changes.created.add(conversationId);
    }
    insertMessage(database, row.conversationId, 'jeffrey', entry.text, entry.at);
    row.replyMessageId = null;
    row.replyText = '';
    row.replyToolCount = 0;
    changes.updated.add(row.conversationId);
    return;
  }
  // A reply only belongs to a conversation once one of its prompts landed.
  if (!row.conversationId) return;
  if (entry.kind === 'reply') row.replyText = row.replyText ? `${row.replyText}\n\n${entry.text}` : entry.text;
  else row.replyToolCount += 1;
  const body = replyBody(row.replyText, row.replyToolCount);
  if (row.replyMessageId) {
    database.prepare('UPDATE shared_messages SET body = ?, completed_at = ? WHERE id = ?').run(body, entry.at, row.replyMessageId);
    database.prepare('UPDATE shared_conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?').run(entry.at, row.conversationId);
  } else {
    row.replyMessageId = insertMessage(database, row.conversationId, row.provider, body, entry.at);
  }
  changes.updated.add(row.conversationId);
}

function decideOrigin(row: ImportRow, session: NonNullable<ParsedTranscriptLine['session']>, owned: Record<TerminalProvider, Set<string>>): void {
  row.cwd = session.cwd;
  if (session.origin === 'workbench') { row.status = 'skipped'; row.skipReason = 'workbench run'; return; }
  if (session.cwd && isManagedRunWorktree(session.cwd)) { row.status = 'skipped'; row.skipReason = 'workbench worktree'; return; }
  if (owned[row.provider].has(row.sessionId)) { row.status = 'skipped'; row.skipReason = 'workbench session'; return; }
  row.status = 'terminal';
}

/**
 * Applies one chunk of complete lines inside a single write transaction.
 * The stored offset must still equal the offset the chunk was read from;
 * otherwise another runtime (a promotion overlap) already imported it.
 */
function applyChunk(
  database: WorkbenchDatabase,
  base: ImportRow,
  persisted: boolean,
  lines: string[],
  nextOffset: number,
  owned: Record<TerminalProvider, Set<string>>,
  changes: ChunkChanges,
): ImportRow | null {
  const parse = base.provider === 'claude' ? parseClaudeTranscriptLine : parseCodexTranscriptLine;
  database.exec('BEGIN IMMEDIATE;');
  try {
    const stored = readImportRow(database, base.transcriptPath);
    if (persisted ? stored?.byteOffset !== base.byteOffset : stored !== null) {
      database.exec('ROLLBACK;');
      return null;
    }
    const row: ImportRow = { ...(stored ?? base) };
    if (row.conversationId) {
      const conversation = database.prepare('SELECT deleted_at FROM shared_conversations WHERE id = ?').get(row.conversationId) as { deleted_at: string | null } | undefined;
      if (!conversation || conversation.deleted_at) { row.status = 'skipped'; row.skipReason = 'conversation deleted'; }
    }
    for (const line of lines) {
      if (row.status === 'skipped') break;
      const parsed = parse(line);
      if (!parsed) continue;
      if (row.status === 'pending' && parsed.session) decideOrigin(row, parsed.session, owned);
      if (row.status !== 'terminal') continue;
      for (const entry of parsed.entries) applyEntry(database, row, entry, changes);
    }
    row.byteOffset = nextOffset;
    writeImportRow(database, row, new Date().toISOString());
    database.exec('COMMIT;');
    return row;
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

async function syncTranscript(database: WorkbenchDatabase, file: TranscriptFile, existing: ImportRow | null, importSince: string, owned: Record<TerminalProvider, Set<string>>, changes: ChunkChanges): Promise<void> {
  let row: ImportRow = existing ?? {
    transcriptPath: file.path, provider: file.provider, sessionId: file.sessionId, status: 'pending', skipReason: null, cwd: null,
    conversationId: null, byteOffset: 0, importSince, replyMessageId: null, replyText: '', replyToolCount: 0, createdAt: new Date().toISOString(),
  };
  let persisted = existing !== null;
  while (row.status !== 'skipped') {
    const chunk = await readCompleteLines(file.path, row.byteOffset);
    if (persisted && chunk.size < row.byteOffset) {
      // The file was rewritten shorter; never replay it into the same conversation.
      row = { ...row, status: 'skipped', skipReason: 'transcript truncated' };
      writeImportRow(database, row, new Date().toISOString());
      return;
    }
    if (chunk.nextOffset === row.byteOffset) return;
    const next = applyChunk(database, row, persisted, chunk.lines, chunk.nextOffset, owned, changes);
    if (!next) return;
    row = next;
    persisted = true;
    // Yield between chunks so a first import of a very large transcript
    // never holds the event loop the scheduler heartbeat shares.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * One pass over the transcripts. Pass `paths` to look only at files a
 * watcher reported; otherwise both roots are listed.
 */
export async function syncTerminalSessions(database: WorkbenchDatabase, options: TerminalSessionSyncOptions = {}, paths?: string[]): Promise<TerminalSessionSyncResult> {
  const resolved = resolveOptions(options);
  const now = resolved.now();
  const cutoffMs = now - resolved.lookbackMs;
  const importSince = new Date(cutoffMs).toISOString();
  const candidatePaths = paths ?? [...await listJsonl(resolved.claudeProjectsRoot), ...await listJsonl(resolved.codexSessionsRoot)];
  const files = await statTranscripts(candidatePaths, resolved);
  const rows = new Map((database.prepare('SELECT * FROM terminal_session_imports').all() as Array<Record<string, unknown>>)
    .map((row) => [String(row.transcript_path), mapImportRow(row)]));
  const changes: ChunkChanges = { created: new Set(), updated: new Set() };
  let owned: Record<TerminalProvider, Set<string>> | null = null;

  for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    const row = rows.get(file.path) ?? null;
    if (row?.status === 'skipped') continue;
    if (!row && file.mtimeMs < cutoffMs) continue;
    if (row && file.size === row.byteOffset) continue;
    owned ??= loadOwnedSessionIds(database);
    try {
      await syncTranscript(database, file, row, importSince, owned, changes);
    } catch (error) {
      console.warn(`Terminal session sync skipped ${file.path} this pass:`, error instanceof Error ? error.message : error);
    }
  }
  return { createdConversationIds: [...changes.created], updatedConversationIds: [...changes.updated] };
}

/**
 * Watches both transcript roots and re-scans on a slow timer as a backstop
 * for missed file events. Passes never overlap; requests that arrive during
 * a pass are merged into the next one.
 */
export function startTerminalSessionSync(database: WorkbenchDatabase, options: TerminalSessionSyncOptions & {
  rescanMs?: number;
  watch?: boolean;
  onChange?: (result: TerminalSessionSyncResult) => void;
} = {}) {
  const resolved = resolveOptions(options);
  const onChange = options.onChange ?? ((result: TerminalSessionSyncResult) => {
    publishRealtimeEvent('shared-metadata');
    for (const conversationId of result.updatedConversationIds) publishRealtimeMessagesEvent(conversationId);
  });
  let stopped = false;
  let running: Promise<void> | null = null;
  let pendingAll = false;
  const pendingPaths = new Set<string>();
  let debounce: NodeJS.Timeout | null = null;

  const drain = async () => {
    while (!stopped && (pendingAll || pendingPaths.size)) {
      const paths = pendingAll ? undefined : [...pendingPaths];
      pendingAll = false;
      pendingPaths.clear();
      try {
        const result = await syncTerminalSessions(database, options, paths);
        if (result.updatedConversationIds.length) onChange(result);
      } catch (error) {
        console.warn('Terminal session sync pass failed; the next pass will retry.', error);
      }
    }
  };
  const run = () => {
    running ??= drain().finally(() => { running = null; });
    return running;
  };
  const syncNow = () => { pendingAll = true; return run(); };

  const watchers: FSWatcher[] = [];
  if (options.watch !== false) {
    for (const root of [resolved.claudeProjectsRoot, resolved.codexSessionsRoot]) {
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
          if (stopped || !filename || !String(filename).endsWith('.jsonl')) return;
          pendingPaths.add(join(root, String(filename)));
          if (debounce) return;
          debounce = setTimeout(() => { debounce = null; void run(); }, WATCH_DEBOUNCE_MS);
          debounce.unref();
        });
        watcher.on('error', () => watcher.close());
        watchers.push(watcher);
      } catch {
        // A missing root is found by the periodic rescan once it exists.
      }
    }
  }

  void syncNow();
  const timer = setInterval(() => void syncNow(), options.rescanMs ?? RESCAN_MS);
  timer.unref();
  return {
    syncNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      for (const watcher of watchers) watcher.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Claude Code hook events

/** The hook payload fields Workbench reads, plus the provider the hook script adds. */
export type TerminalHookPayload = {
  provider: 'claude';
  hook_event_name: 'SessionStart' | 'UserPromptSubmit' | 'Stop';
  session_id: string;
  cwd?: string | null;
  prompt_id?: string;
  prompt?: string;
  last_assistant_message?: string;
  /** CLAUDE_CODE_ENTRYPOINT as the hook script saw it; `sdk-*` marks a `claude -p` run. */
  entrypoint?: string;
};

export type TerminalHookResult =
  | { status: 'applied'; conversationId: string; created: boolean; changed: boolean }
  | { status: 'skipped'; reason: string };

const DEFAULT_TERMINAL_TITLE = 'Terminal session';

/** The registered project a working directory belongs to, matched by directory name. */
function projectForCwd(database: WorkbenchDatabase, cwd: string | null): string | null {
  const key = cwd ? projectKey(basename(cwd)) : '';
  if (!key) return null;
  const direct = database.prepare('SELECT name FROM projects WHERE key = ?').get(key) as { name: string } | undefined;
  if (direct) return direct.name;
  const alias = database.prepare('SELECT p.name FROM project_aliases a JOIN projects p ON p.id = a.project_id WHERE a.alias_key = ?').get(key) as { name: string } | undefined;
  return alias?.name ?? null;
}

type HookSession = { status: 'terminal' | 'skipped'; skip_reason: string | null; conversation_id: string | null };

function skipReasonFor(database: WorkbenchDatabase, payload: TerminalHookPayload): string | null {
  if (payload.entrypoint?.startsWith('sdk')) return 'workbench run';
  if (payload.cwd && isManagedRunWorktree(payload.cwd)) return 'workbench worktree';
  const owned = database.prepare(`
    SELECT 1 FROM shared_conversations WHERE claude_session_id = ?
    UNION SELECT 1 FROM agent_sessions WHERE agent = 'claude' AND provider_session_id = ?
  `).get(payload.session_id, payload.session_id);
  return owned ? 'workbench session' : null;
}

/**
 * Finds or creates the hook session row and its conversation. A conversation
 * the transcript sync already created for this session is adopted so the
 * session never produces two, and its transcript rows stop importing.
 */
function ensureHookSession(database: WorkbenchDatabase, payload: TerminalHookPayload, at: string): { session: HookSession; created: boolean } {
  const existing = database.prepare('SELECT status, skip_reason, conversation_id FROM terminal_hook_sessions WHERE provider = ? AND session_id = ?')
    .get(payload.provider, payload.session_id) as HookSession | undefined;
  if (existing) {
    if (existing.status === 'terminal' && existing.conversation_id) {
      const conversation = database.prepare('SELECT deleted_at FROM shared_conversations WHERE id = ?').get(existing.conversation_id) as { deleted_at: string | null } | undefined;
      if (!conversation || conversation.deleted_at) return { session: { status: 'skipped', skip_reason: 'conversation deleted', conversation_id: existing.conversation_id }, created: false };
    }
    return { session: existing, created: false };
  }
  const cwd = payload.cwd ?? null;
  const record = (session: HookSession) => {
    database.prepare('INSERT INTO terminal_hook_sessions (provider, session_id, status, skip_reason, cwd, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(payload.provider, payload.session_id, session.status, session.skip_reason, cwd, session.conversation_id, at);
  };

  const imported = database.prepare("SELECT conversation_id FROM terminal_session_imports WHERE provider = ? AND session_id = ? AND status = 'terminal' AND conversation_id IS NOT NULL LIMIT 1")
    .get(payload.provider, payload.session_id) as { conversation_id: string } | undefined;
  if (imported) {
    database.prepare('UPDATE shared_conversations SET claude_session_id = ? WHERE id = ? AND claude_session_id IS NULL').run(payload.session_id, imported.conversation_id);
    database.prepare("UPDATE terminal_session_imports SET status = 'skipped', skip_reason = 'hook bridge', updated_at = ? WHERE provider = ? AND session_id = ?")
      .run(at, payload.provider, payload.session_id);
    const session: HookSession = { status: 'terminal', skip_reason: null, conversation_id: imported.conversation_id };
    record(session);
    return { session, created: false };
  }

  const reason = skipReasonFor(database, payload);
  if (reason) {
    const session: HookSession = { status: 'skipped', skip_reason: reason, conversation_id: null };
    record(session);
    return { session, created: false };
  }

  const conversationId = randomUUID();
  database.prepare('INSERT INTO shared_conversations (id, title, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(conversationId, DEFAULT_TERMINAL_TITLE, payload.session_id, at, at);
  insertMessage(database, conversationId, 'system', syncMarker(payload.provider, payload.session_id, cwd, projectForCwd(database, cwd)), at);
  const session: HookSession = { status: 'terminal', skip_reason: null, conversation_id: conversationId };
  record(session);
  return { session, created: true };
}

/**
 * Applies one Claude Code hook event. Prompts and stops are keyed by
 * `prompt_id`, so a hook that retries lands exactly once.
 */
export function applyTerminalHookEvent(database: WorkbenchDatabase, payload: TerminalHookPayload, now: () => Date = () => new Date()): TerminalHookResult {
  // Checked on every event, not only when the session row is first recorded:
  // a Workbench reply to a terminal conversation resumes the same provider
  // session with `claude -p`, and those hook events must never land as
  // Jeffrey's words or as a second copy of the reply.
  if (payload.entrypoint?.startsWith('sdk')) return { status: 'skipped', reason: 'workbench run' };
  if (payload.cwd && isManagedRunWorktree(payload.cwd)) return { status: 'skipped', reason: 'workbench worktree' };
  const at = now().toISOString();
  database.exec('BEGIN IMMEDIATE;');
  try {
    const { session, created } = ensureHookSession(database, payload, at);
    if (session.status !== 'terminal' || !session.conversation_id) {
      database.exec('COMMIT;');
      return { status: 'skipped', reason: session.skip_reason ?? 'skipped' };
    }
    const conversationId = session.conversation_id;
    let changed = created;
    const kind = payload.hook_event_name === 'UserPromptSubmit' ? 'prompt' : payload.hook_event_name === 'Stop' ? 'stop' : null;
    // A UserPromptSubmit hook also fires for text the harness injects on
    // Jeffrey's behalf (task notifications, system reminders). Those are not
    // his words and never title or populate the conversation.
    const text = kind === 'prompt' ? typedText([payload.prompt ?? '']) : payload.last_assistant_message?.trim() ?? '';
    if (kind && payload.prompt_id && text) {
      const seen = database.prepare('SELECT 1 FROM terminal_hook_events WHERE provider = ? AND session_id = ? AND prompt_id = ? AND kind = ?')
        .get(payload.provider, payload.session_id, payload.prompt_id, kind);
      if (!seen) {
        if (kind === 'prompt') {
          // Also replaces a title taken from injected text before this filter existed.
          database.prepare("UPDATE shared_conversations SET title = ? WHERE id = ? AND (title = ? OR title LIKE '<%')").run(titleFromPrompt(text), conversationId, DEFAULT_TERMINAL_TITLE);
        }
        const messageId = insertMessage(database, conversationId, kind === 'prompt' ? 'jeffrey' : payload.provider, text, at);
        database.prepare('INSERT INTO terminal_hook_events (provider, session_id, prompt_id, kind, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(payload.provider, payload.session_id, payload.prompt_id, kind, messageId, at);
        changed = true;
      }
    }
    database.exec('COMMIT;');
    return { status: 'applied', conversationId, created, changed };
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}
