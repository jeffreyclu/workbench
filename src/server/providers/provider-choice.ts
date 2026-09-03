import { DEFAULT_ACCOUNT_PROFILE, PERSONAL_ACCOUNT_PROFILE } from '../../shared/contracts.js';
import type { AiProviderAvailability, AiProviderChoice, ResolvedAiProvider } from '../../shared/ai-providers.js';
import { isPalmyraConfigured, palmyraModel } from './palmyra.js';

/** There is exactly one Writer key on this machine and it is the work
 * credential — no personal Writer key exists. Refusing the personal profile
 * would disable Palmyra on Workbench itself, which runs under exactly that
 * profile, so the one key serves every profile and the selector says plainly
 * which credential a personal-profile turn spends. The profile still travels
 * with every request, so a per-profile key would change this in one place. */
export function palmyraAvailability(accountProfile: string = DEFAULT_ACCOUNT_PROFILE): AiProviderAvailability['palmyra'] {
  const model = palmyraModel();
  if (!isPalmyraConfigured()) return { available: false, reason: 'No Writer API key is configured on this machine.', model };
  if (accountProfile === PERSONAL_ACCOUNT_PROFILE) return { available: true, reason: 'There is no personal Writer key, so personal-profile turns spend the work key.', model };
  return { available: true, reason: null, model };
}

/** `auto` reproduces the behavior that shipped before any selector existed:
 * Palmyra when it is usable, Claude otherwise. An explicit `palmyra` that is
 * not usable still falls back to Claude — the request has to be answered — but
 * the selector has already told the caller why. */
export function resolveAiProvider(choice: AiProviderChoice | null | undefined, accountProfile: string = DEFAULT_ACCOUNT_PROFILE): ResolvedAiProvider {
  if (choice === 'claude') return 'claude';
  return palmyraAvailability(accountProfile).available ? 'palmyra' : 'claude';
}

export function aiProviderAvailability(choice: AiProviderChoice | null | undefined, accountProfile: string = DEFAULT_ACCOUNT_PROFILE): AiProviderAvailability {
  return { accountProfile, resolved: resolveAiProvider(choice, accountProfile), palmyra: palmyraAvailability(accountProfile) };
}
