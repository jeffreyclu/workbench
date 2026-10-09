import type { TerminalLine, TerminalSessionInfo, TerminalSnapshot } from '../shared/contracts.js';
import type { WorkbenchDatabase } from './database.js';
import { readableAgentEvent } from './agent-runner.js';
import { readMirroredTerminalLines, readTerminalMirror } from './terminal-session-sync.js';
import { readAgentSessionStatus, readSessionEventsFromFile, type AgentSessionEvent, type AgentSessionKey, type AgentSessionState } from './agent-session.js';

export type { TerminalLine, TerminalSessionInfo, TerminalSnapshot };

const RESULT_PREVIEW_CHARS = 240;
export const MAX_TERMINAL_LINE_CHARS = 16_000;

function terminalText(text: string): string {
  const suffix = '\u2026 [truncated]';
  return text.length > MAX_TERMINAL_LINE_CHARS
    ? `${text.slice(0, MAX_TERMINAL_LINE_CHARS - suffix.length)}${suffix}`
    : text;
}

function resultLines(event: unknown): string[] {
  const content = (event as { message?: { content?: unknown } } | null)?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: { type?: string; content?: unknown }) => {
    if (block?.type !== 'tool_result') return [];
    const text = typeof block.content === 'string' ? block.content
      : Array.isArray(block.content) ? block.content.map((part: { text?: unknown }) => typeof part?.text === 'string' ? part.text : '').join(' ') : '';
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, RESULT_PREVIEW_CHARS);
    return [`↳ ${preview || '(no output)'}`];
  });
}

type CodexItem = { type?: string; text?: string; command?: string; name?: string; tool?: string; status?: string; aggregatedOutput?: unknown; output?: unknown; result?: unknown };

/**
 * Codex app-server notifications are JSON-RPC methods, not Claude stream-json
 * events, so readableAgentEvent yields nothing for them. Message deltas become
 * `delta` lines, command and tool items become `tool` lines with a result
 * preview, and reasoning collapses to one marker when it completes.
 */
function codexTerminalLines(event: unknown): Array<{ kind: TerminalLine['kind']; text: string }> | null {
  const method = (event as { method?: unknown } | null)?.method;
  if (typeof method !== 'string') return null;
  const params = ((event as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>;
  if (method === 'item/agentMessage/delta') return typeof params.delta === 'string' && params.delta ? [{ kind: 'delta', text: params.delta }] : [];
  const item = (params.item ?? null) as CodexItem | null;
  if (!item) return [];
  const type = item.type ?? '';
  if (method === 'item/started' && (type === 'commandExecution' || type === 'command_execution')) return [{ kind: 'tool', text: `● command: ${item.command ?? ''}` }];
  if (method === 'item/completed' && (type === 'commandExecution' || type === 'command_execution')) {
    const output = item.aggregatedOutput ?? item.output ?? item.result ?? '';
    const preview = String(typeof output === 'string' ? output : JSON.stringify(output)).replace(/\s+/g, ' ').trim().slice(0, RESULT_PREVIEW_CHARS);
    return [{ kind: 'result', text: `↳ ${item.status === 'failed' ? '(failed) ' : ''}${preview || '(no output)'}` }];
  }
  if (method === 'item/started' && (type === 'mcpToolCall' || type === 'customToolCall' || type === 'mcp_tool_call' || type === 'custom_tool_call')) return [{ kind: 'tool', text: `● tool: ${item.name ?? item.tool ?? type}` }];
  if (method === 'item/completed' && type === 'reasoning') return [{ kind: 'text', text: '· thinking' }];
  // The completed agentMessage repeats the streamed deltas; end the line instead of duplicating the text.
  if (method === 'item/completed' && (type === 'agentMessage' || type === 'agent_message')) return [{ kind: 'text', text: '' }];
  return [];
}

/** Plain-text lines for one log record; the attach script and the panel both render these. */
export function terminalLinesFor(agent: AgentSessionKey['agent'], record: AgentSessionEvent): TerminalLine[] {
  const base = { offset: record.offset, at: record.at };
  if (record.source === 'host') {
    if (record.type === 'turn_started') return [{ ...base, kind: 'host', text: terminalText(`> ${String(record.prompt ?? '')}`) }];
    if (record.type === 'turn_terminal') return [{ ...base, kind: 'host', text: terminalText(`■ turn ${record.status ?? 'ended'}${record.reason ? `: ${record.reason}` : ''}`) }];
    return [{ ...base, kind: 'host', text: terminalText(`· ${record.type ?? 'host event'}${record.reason ? `: ${String(record.reason)}` : ''}`) }];
  }
  if (record.raw !== undefined) return [{ ...base, kind: 'text', text: terminalText(record.raw) }];
  const codex = agent === 'codex' ? codexTerminalLines(record.event) : null;
  if (codex) return codex.map((item) => ({ ...base, ...item, text: terminalText(item.text) }));
  const line = JSON.stringify(record.event);
  const results = resultLines(record.event).map((text) => ({ ...base, kind: 'result' as const, text }));
  const readable = readableAgentEvent(agent, line);
  const rendered: TerminalLine[] = [];
  if (readable.delta) rendered.push({ ...base, kind: 'delta', text: readable.delta });
  else if (readable.progress) rendered.push({ ...base, kind: readable.progress.startsWith('●') ? 'tool' : 'text', text: readable.progress });
  return [...rendered, ...results].map((item) => ({ ...item, text: terminalText(item.text) }));
}

export function readTerminalSnapshot(database: WorkbenchDatabase, key: AgentSessionKey, offset: number): TerminalSnapshot {
  const { events, nextOffset } = readSessionEventsFromFile(key, offset);
  const status = readAgentSessionStatus(key);
  const row = database.prepare('SELECT model, state, provider_session_id FROM agent_sessions WHERE conversation_id = ? AND agent = ?').get(key.conversationId, key.agent) as
    { model: string | null; state: AgentSessionState; provider_session_id: string | null } | undefined;
  if (!status && !row && nextOffset === 0) {
    // No agent_sessions row means Workbench does not own a process here; a mirrored terminal session still has activity to show.
    const mirror = readTerminalMirror(database, key.conversationId, key.agent);
    if (mirror) {
      const lines = readMirroredTerminalLines(database, key.conversationId, key.agent);
      return { session: { state: 'none', pid: null, model: null, providerSessionId: mirror.sessionId, stopReason: null }, lines, nextOffset: lines.length, mirror };
    }
  }
  return {
    session: {
      state: status?.state ?? row?.state ?? 'none',
      pid: status?.pid ?? null,
      model: row?.model ?? null,
      providerSessionId: status?.providerSessionId ?? row?.provider_session_id ?? null,
      stopReason: status?.stopReason ?? null,
    },
    lines: events.flatMap((event) => terminalLinesFor(key.agent, event)),
    nextOffset,
  };
}
