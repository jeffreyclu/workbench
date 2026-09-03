import { useId } from 'react';
import { useAiProviderAvailability } from '../hooks/ai-provider';

export type ComposerProvider = 'both' | 'codex' | 'claude' | 'palmyra';

export function ComposerProviderSelect({ value, onChange, accountProfile, disabled = false }: {
  value: ComposerProvider;
  onChange: (provider: ComposerProvider) => void;
  accountProfile?: string | null;
  disabled?: boolean;
}) {
  const selectId = useId();
  const availability = useAiProviderAvailability(value === 'palmyra' ? 'palmyra' : 'auto', accountProfile);
  const palmyra = availability.data?.palmyra;
  const palmyraBlocked = Boolean(palmyra) && !palmyra!.available;
  const note = palmyra ? palmyra.reason ?? `Writer ${palmyra.model}` : undefined;

  return <>
    <label className="visually-hidden" htmlFor={selectId}>Provider</label>
    <select
      id={selectId}
      className="agent-target dispatch-target"
      value={value}
      onChange={(event) => onChange(event.target.value as ComposerProvider)}
      title={value === 'palmyra' ? note : undefined}
      disabled={disabled}
    >
      <option value="codex">Codex</option>
      <option value="claude">Claude</option>
      <option value="palmyra" disabled={palmyraBlocked}>Palmyra{palmyraBlocked ? ' · unavailable' : ''}</option>
      <option value="both">Codex + Claude</option>
    </select>
  </>;
}
