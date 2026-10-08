import { memo } from 'react';
import type { TerminalLine, TerminalSessionInfo } from '../../../shared/contracts';
import { attachCommand, resumeWarning } from './terminal-lines';

export interface TerminalPanelProps {
  conversationId: string;
  agent: 'claude' | 'codex';
  lines: TerminalLine[];
  session: TerminalSessionInfo | null;
  error: string | null;
}

function describeSession(session: TerminalSessionInfo | null): string {
  if (!session) return 'Connecting…';
  if (session.state === 'none') return 'No live session';
  return [session.state === 'turn' ? 'Working' : session.state === 'idle' ? 'Idle' : 'Stopped', session.pid ? `PID ${session.pid}` : null, session.model].filter(Boolean).join(' · ');
}

/** Read-only view of one agent's raw session log; typing happens through the conversation or the attach script. */
export const TerminalPanel = memo(function TerminalPanel({ conversationId, agent, lines, session, error }: TerminalPanelProps) {
  const warning = session ? resumeWarning(agent, session.providerSessionId, session.state) : null;
  const stopped = session?.state === 'stopped';
  const empty = lines.length === 0;
  return (
    <section className="terminal-panel" aria-label={`${agent} terminal`}>
      <header className="terminal-panel-header">
        <strong>{agent === 'claude' ? 'Claude' : 'Codex'}</strong>
        <span role="status">{describeSession(session)}</span>
      </header>
      {error && <p className="terminal-panel-error" role="alert">{error}</p>}
      {warning && <p className="terminal-panel-warning" role="note">{warning}</p>}
      {stopped && <p className="terminal-panel-stopped" role="note">Session stopped{session?.stopReason ? `: ${session.stopReason}` : ''}. The next message starts it again.</p>}
      <pre className="terminal-panel-log" tabIndex={0} aria-live="polite" aria-label={`${agent} session output`}>
        {empty
          ? (session && session.state !== 'none' ? 'Waiting for output…' : 'No session output yet. Send a message to start one.')
          : lines.map((line, index) => <span key={`${line.offset}-${index}`} className={`terminal-line terminal-line-${line.kind}`}>{line.text}{line.kind === 'delta' ? '' : '\n'}</span>)}
      </pre>
      <footer className="terminal-panel-footer">
        <label>Attach in tmux <input readOnly value={attachCommand(conversationId, agent)} onFocus={(event) => event.currentTarget.select()} /></label>
      </footer>
    </section>
  );
});
