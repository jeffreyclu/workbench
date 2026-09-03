import { useId } from 'react';
import type { AgentRun } from '../../shared/contracts';
import { useAiProviderAvailability } from '../hooks/ai-provider';

type ComposerProfile = Exclude<AgentRun['executionProfile'], 'routing'>;

export function ComposerModelSelect({ executionProfile, provider, onChange, accountProfile, disabled = false }: {
  executionProfile: ComposerProfile;
  provider: 'both' | 'codex' | 'claude' | 'palmyra';
  onChange: (profile: ComposerProfile) => void;
  accountProfile?: string | null;
  disabled?: boolean;
}) {
  const selectId = useId();
  const availability = useAiProviderAvailability(provider === 'palmyra' ? 'palmyra' : 'auto', accountProfile);
  const model = availability.data?.palmyra?.model ?? 'Palmyra';
  return <>
    <label className="visually-hidden" htmlFor={selectId}>Model choice</label>
    {provider === 'palmyra'
      ? <select id={selectId} className="model-target" value={model} disabled><option value={model}>{model}</option></select>
      : <select id={selectId} className="model-target" value={executionProfile ?? 'auto'} onChange={(event) => onChange(event.target.value === 'auto' ? null : event.target.value as NonNullable<ComposerProfile>)} disabled={disabled}>
        <option value="auto">Auto</option>
        <option value="economy">Fast</option>
        <option value="standard">Balanced</option>
        <option value="deep">Deep</option>
      </select>}
  </>;
}
