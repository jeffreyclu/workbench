import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PaletteCommand, PaletteMode } from './logic';

interface PaletteState {
  open: boolean;
  mode: PaletteMode;
  commands: PaletteCommand[];
  openPalette: (mode: PaletteMode) => void;
  close: () => void;
}
type Register = (owner: string, commands: PaletteCommand[]) => () => void;

const PaletteContext = createContext<PaletteState | null>(null);
// Registration is its own context with a stable value, so a screen that
// contributes commands is not re-rendered every time the palette opens.
const RegisterContext = createContext<Register | null>(null);

function isPaletteShortcut(event: KeyboardEvent): PaletteMode | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  return key === 'k' ? 'commands' : key === 'p' ? 'switcher' : null;
}

/**
 * Owns the palette's open state and the commands each screen contributes.
 * Screens register while mounted, so the palette lists exactly what the user
 * can act on right now (for example a changeset's files only on Changes).
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; mode: PaletteMode }>({ open: false, mode: 'commands' });
  const [registered, setRegistered] = useState<ReadonlyMap<string, PaletteCommand[]>>(new Map());

  const register = useCallback((owner: string, commands: PaletteCommand[]) => {
    setRegistered((current) => new Map(current).set(owner, commands));
    return () => setRegistered((current) => {
      if (!current.has(owner)) return current;
      const next = new Map(current);
      next.delete(owner);
      return next;
    });
  }, []);
  const openPalette = useCallback((mode: PaletteMode) => setState({ open: true, mode }), []);
  const close = useCallback(() => setState((current) => ({ ...current, open: false })), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mode = isPaletteShortcut(event);
      if (!mode) return;
      // ⌘P would otherwise open the browser's print dialog.
      event.preventDefault();
      setState((current) => current.open && current.mode === mode ? { ...current, open: false } : { open: true, mode });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const commands = useMemo(() => [...registered.values()].flat(), [registered]);
  const value = useMemo(() => ({ ...state, commands, openPalette, close }), [state, commands, openPalette, close]);
  return <RegisterContext.Provider value={register}><PaletteContext.Provider value={value}>{children}</PaletteContext.Provider></RegisterContext.Provider>;
}

export function usePalette() {
  const context = useContext(PaletteContext);
  if (!context) throw new Error('usePalette must be used inside CommandPaletteProvider');
  return context;
}

/**
 * Contributes commands to the palette for as long as the caller is mounted.
 * Outside a provider it does nothing, so screens render unchanged in isolation.
 * Callers pass a memoized list; a new list replaces the previous one.
 */
export function usePaletteCommands(owner: string, commands: PaletteCommand[]) {
  const register = useContext(RegisterContext);
  useEffect(() => register?.(owner, commands), [register, owner, commands]);
}
