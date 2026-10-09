import type { TerminalLine, TerminalSessionInfo, TerminalSnapshot } from '../shared/contracts.js';
import type { WorkbenchDatabase } from './database.js';
import { readableAgentEvent } from './agent-runner.js';
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

/** Plain-text lines for one log record; the attach script and the panel both render these. */
export function terminalLinesFor(agent: AgentSessionKey['agent'], record: AgentSessionEvent): TerminalLine[] {
  const base = { offset: record.offset, at: record.at };
  if (record.source === 'host') {
    if (record.type === 'turn_started') return [{ ...base, kind: 'host', text: terminalText(`> ${String(record.prompt ?? '')}`) }];
    if (record.type === 'turn_terminal') return [{ ...base, kind: 'host', text: terminalText(`■ turn ${record.status ?? 'ended'}${record.reason ? `: ${record.reason}` : ''}`) }];
    return [{ ...base, kind: 'host', text: terminalText(`· ${record.type ?? 'host event'}${record.reason ? `: ${String(record.reason)}` : ''}`) }];
  }
  if (record.raw !== undefined) return [{ ...base, kind: 'text', text: terminalText(record.raw) }];
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
