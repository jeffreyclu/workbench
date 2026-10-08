import type { TerminalLine } from '../../../shared/contracts';

/** The panel keeps the most recent lines only; the full log stays in events.jsonl. */
export const MAX_TERMINAL_LINES = 500;

/** Streaming fragments extend the previous delta line instead of becoming one line per token. */
export function appendTerminalLines(current: TerminalLine[], incoming: TerminalLine[]): TerminalLine[] {
  if (incoming.length === 0) return current;
  const next = [...current];
  for (const line of incoming) {
    const last = next[next.length - 1];
    if (line.kind === 'delta' && last?.kind === 'delta') next[next.length - 1] = { ...last, text: last.text + line.text };
    else next.push(line);
  }
  return next.length > MAX_TERMINAL_LINES ? next.slice(next.length - MAX_TERMINAL_LINES) : next;
}

/** `claude --resume` against a live session id forks it and corrupts the record, so the panel warns instead. */
export function resumeWarning(agent: 'claude' | 'codex', providerSessionId: string | null, state: string): string | null {
  if (state === 'stopped' || state === 'none') return null;
  return `This ${agent} session is live${providerSessionId ? ` (${providerSessionId})` : ''}. Do not run \`${agent} resume\`/\`--resume\` on it; type through \`npx tsx scripts/attach-session.ts\` or the conversation instead.`;
}

export function attachCommand(conversationId: string, agent: 'claude' | 'codex'): string {
  return `npx tsx scripts/attach-session.ts ${conversationId} ${agent}`;
}
