import type { AgentRun } from '../../shared/contracts';
import type { AiProviderChoice } from '../../shared/ai-providers';
import { useAiProviderAvailability } from '../hooks/ai-provider';

type ComposerProfile = Exclude<AgentRun['executionProfile'], 'routing'>;

/** The composer's single model control. Palmyra sits in the same list as the
 * Claude tiers (Fast/Balanced/Deep resolve to haiku/sonnet/opus) rather than in
 * a separate provider dropdown: from the composer there is one question — which
 * model handles this conversation — so there is one answer control.
 *
 * The two preferences behind it stay distinct server-side. A tier picks the
 * agent's model; Palmyra picks the model for Workbench's own AI turns, which is
 * the only work Palmyra can do (structured JSON, no tools). Choosing Palmyra
 * therefore returns the agent tier to Auto instead of pretending a tier is
 * still in force. */
export function ComposerModelSelect({ executionProfile, aiProvider, onChange, accountProfile, className = '', disabled = false }: {
  executionProfile: ComposerProfile;
  aiProvider: AiProviderChoice;
  onChange: (next: { executionProfile: ComposerProfile; aiProvider: AiProviderChoice }) => void;
  accountProfile?: string | null;
  className?: string;
  disabled?: boolean;
}) {
  const availability = useAiProviderAvailability(aiProvider, accountProfile);
  const palmyra = availability.data?.palmyra;
  const palmyraBlocked = Boolean(palmyra) && !palmyra!.available;
  const palmyraSelected = aiProvider === 'palmyra';
  // Shown whether or not Palmyra is usable: blocked says why, usable says which
  // Writer credential the turn spends, so neither is invisible.
  const note = palmyra ? palmyra.reason ?? `Palmyra model ${palmyra.model}` : undefined;
  return (
    <select
      className={`${className} composer-model-target`.trim()}
      value={palmyraSelected ? 'palmyra' : executionProfile ?? 'auto'}
      onChange={(event) => {
        const choice = event.target.value;
        if (choice === 'palmyra') return onChange({ executionProfile: null, aiProvider: 'palmyra' });
        // Leaving Palmyra returns grounding to Auto; an explicit Claude choice
        // made elsewhere is left alone, since picking a tier is not a statement
        // about grounding.
        onChange({ executionProfile: choice === 'auto' ? null : choice as NonNullable<ComposerProfile>, aiProvider: palmyraSelected ? 'auto' : aiProvider });
      }}
      aria-label="Model choice"
      title={palmyraSelected ? note : undefined}
      disabled={disabled}
    >
      <option value="auto">Auto</option>
      <option value="economy">Fast</option>
      <option value="standard">Balanced</option>
      <option value="deep">Deep</option>
      <option value="palmyra" disabled={palmyraBlocked} title={note}>Palmyra{palmyraBlocked ? ' · unavailable' : ''}</option>
    </select>
  );
}
