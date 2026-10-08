import { useEffect, useState } from 'react';
import type { TerminalLine, TerminalSessionInfo } from '../../../shared/contracts';
import { conversationData } from './data';
import { appendTerminalLines } from './terminal-lines';

const POLL_MS = 1_000;
const ERROR_POLL_MS = 5_000;

export interface SessionTerminalState {
  lines: TerminalLine[];
  session: TerminalSessionInfo | null;
  error: string | null;
}

/**
 * Tails a session's log over the realtime request channel. The byte offset is
 * held by the loop, so a reconnect continues where it stopped; the loop is the
 * one place this feature needs an effect because the stream has no push event.
 */
export function useSessionTerminal(conversationId: string, agent: 'claude' | 'codex', enabled: boolean): SessionTerminalState {
  const [state, setState] = useState<SessionTerminalState>({ lines: [], session: null, error: null });
  useEffect(() => {
    setState({ lines: [], session: null, error: null });
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let offset = 0;
    const poll = async () => {
      let delay = POLL_MS;
      try {
        const snapshot = await conversationData.tailTerminal(conversationId, agent, offset, controller.signal);
        if (controller.signal.aborted) return;
        offset = snapshot.nextOffset;
        setState((current) => ({ lines: appendTerminalLines(current.lines, snapshot.lines), session: snapshot.session, error: null }));
      } catch (error) {
        if (controller.signal.aborted) return;
        delay = ERROR_POLL_MS;
        setState((current) => ({ ...current, error: error instanceof Error ? error.message : 'Could not read the session log.' }));
      }
      timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [conversationId, agent, enabled]);
  return state;
}
