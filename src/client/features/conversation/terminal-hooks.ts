import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { TerminalLine, TerminalSessionInfo, TerminalSnapshot } from '../../../shared/contracts';
import { conversationData, conversationQueryKeys } from './data';
import { appendTerminalLines } from './terminal-lines';

const POLL_MS = 1_000;
const ERROR_POLL_MS = 5_000;

export interface SessionTerminalState {
  lines: TerminalLine[];
  session: TerminalSessionInfo | null;
  error: string | null;
  /** Set when the conversation mirrors a terminal session Workbench does not own. */
  mirror: TerminalSnapshot['mirror'];
}

/**
 * Tails a session's log over the request channel. The byte offset is held by
 * the loop, so a reconnect continues where it stopped. The first snapshot
 * decides the mode: a hosted session keeps polling; a mirrored one stops the
 * loop and is refetched by the same realtime message events that refresh
 * stream events, since its activity lives in the database, not a log file.
 */
export function useSessionTerminal(conversationId: string, agent: 'claude' | 'codex', enabled: boolean): SessionTerminalState {
  const [state, setState] = useState<Omit<SessionTerminalState, 'mirror'>>({ lines: [], session: null, error: null });
  const [mirrored, setMirrored] = useState(false);
  useEffect(() => {
    setState({ lines: [], session: null, error: null });
    setMirrored(false);
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let offset = 0;
    const poll = async () => {
      let delay = POLL_MS;
      try {
        const snapshot = await conversationData.tailTerminal(conversationId, agent, offset, controller.signal);
        if (controller.signal.aborted) return;
        if (snapshot.mirror) { setMirrored(true); return; }
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

  const mirror = useQuery({
    queryKey: conversationQueryKeys.terminalMirror(conversationId, agent),
    queryFn: ({ signal }) => conversationData.tailTerminal(conversationId, agent, 0, signal),
    enabled: enabled && mirrored,
  });
  if (mirrored && mirror.data?.mirror) return { lines: mirror.data.lines, session: mirror.data.session, error: null, mirror: mirror.data.mirror };
  if (mirrored && mirror.error) return { ...state, error: mirror.error instanceof Error ? mirror.error.message : 'Could not read the mirrored session.', mirror: null };
  return { ...state, mirror: null };
}
