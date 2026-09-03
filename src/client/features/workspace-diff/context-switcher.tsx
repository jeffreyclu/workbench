import { useEffect, useState } from 'react';

export interface WorkspaceContextOption {
  path: string;
  label: string;
}

interface WorkspaceContextSwitcherProps {
  selectedPath: string | null;
  options: WorkspaceContextOption[];
  onSelect: (workspacePath: string) => Promise<void>;
}

/**
 * Owns the repository-selection transition. The requested path stays visible
 * until the explorer confirms it, so an older explorer response cannot snap
 * the control back to the repository the reviewer just left.
 */
export function WorkspaceContextSwitcher({ selectedPath, options, onSelect }: WorkspaceContextSwitcherProps) {
  const [requestedPath, setRequestedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const displayedPath = requestedPath ?? selectedPath ?? '';

  useEffect(() => {
    if (requestedPath && selectedPath === requestedPath) setRequestedPath(null);
  }, [requestedPath, selectedPath]);

  const select = async (workspacePath: string) => {
    if (!workspacePath || workspacePath === displayedPath) return;
    setRequestedPath(workspacePath);
    setError(null);
    try {
      await onSelect(workspacePath);
    } catch (cause) {
      setRequestedPath(null);
      setError(cause instanceof Error ? cause.message : 'Could not switch repositories.');
    }
  };

  return <label className="workspace-repository-picker">
    <span>Repository</span>
    <select aria-label="Workspace" value={displayedPath} onChange={(event) => void select(event.target.value)} disabled={requestedPath !== null} title={displayedPath || undefined}>
      <option value="" disabled>Select repository</option>
      {options.map((option) => <option key={option.path} value={option.path}>{option.label}</option>)}
    </select>
    {requestedPath && <span className="visually-hidden" role="status">Switching repository</span>}
    {error && <small role="alert">{error}</small>}
  </label>;
}
