import { useState } from 'react';
import { useSessionTerminal } from './terminal-hooks';
import { TerminalPanel } from './terminal-panel';

const AGENTS = ['claude', 'codex'] as const;

/** Terminal panel with an agent switch; polling runs only while the panel is mounted. */
export function SessionTerminal({ conversationId }: { conversationId: string }) {
  const [agent, setAgent] = useState<(typeof AGENTS)[number]>('claude');
  const terminal = useSessionTerminal(conversationId, agent, true);
  return (
    <div className="terminal-drawer">
      <div className="conversation-surface-tabs" role="group" aria-label="Terminal agent">
        {AGENTS.map((name) => <button key={name} type="button" aria-pressed={agent === name} onClick={() => setAgent(name)}>{name === 'claude' ? 'Claude' : 'Codex'}</button>)}
      </div>
      <TerminalPanel conversationId={conversationId} agent={agent} lines={terminal.lines} session={terminal.session} error={terminal.error} />
    </div>
  );
}
