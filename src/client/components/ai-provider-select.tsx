import { AI_PROVIDER_CHOICES, AI_PROVIDER_LABELS, parseAiProviderChoice, type AiProviderChoice } from '../../shared/ai-providers';
import { useAiProviderAvailability } from '../hooks/ai-provider';

/** The one provider selector, rendered anywhere Workbench spends an AI turn.
 * Palmyra is offered as a disabled option rather than hidden when it is not
 * reachable, so the reason is visible instead of the choice silently resolving
 * to Claude. */
export function AiProviderSelect({ value, onChange, accountProfile, disabled, ariaLabel = 'AI provider', className = '' }: {
  value: AiProviderChoice;
  onChange: (next: AiProviderChoice) => void;
  accountProfile?: string | null;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const availability = useAiProviderAvailability(value, accountProfile);
  const palmyra = availability.data?.palmyra;
  const palmyraBlocked = Boolean(palmyra) && !palmyra!.available;
  // The reason is shown whether or not Palmyra is usable: when it is blocked it
  // says why, and when the only Writer key is the work one it says which
  // credential the turn spends instead of leaving that invisible.
  const note = palmyra ? palmyra.reason ?? `Palmyra model ${palmyra.model}` : undefined;
  return (
    <select
      className={`agent-target ai-provider-target ${className}`.trim()}
      value={value}
      onChange={(event) => onChange(parseAiProviderChoice(event.target.value))}
      aria-label={ariaLabel}
      disabled={disabled}
      title={note}
    >
      {AI_PROVIDER_CHOICES.map((choice) => (
        <option key={choice} value={choice} disabled={choice === 'palmyra' && palmyraBlocked}>
          {AI_PROVIDER_LABELS[choice]}{choice === 'palmyra' && palmyraBlocked ? ' · unavailable' : ''}
        </option>
      ))}
    </select>
  );
}
