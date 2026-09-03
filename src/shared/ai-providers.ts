import { z } from 'zod';

/** Which model answers Workbench's small, tool-free, structured-JSON turns:
 * task drafts, diff risk scores, review-assist answers, and turn grounding.
 * `auto` keeps the historical behavior — Palmyra when it is usable on this
 * machine, Claude otherwise — so a selector left alone changes nothing. */
export const AI_PROVIDER_CHOICES = ['auto', 'palmyra', 'claude'] as const;
export const aiProviderChoiceSchema = z.enum(AI_PROVIDER_CHOICES);
export type AiProviderChoice = z.infer<typeof aiProviderChoiceSchema>;

/** What actually ran. `auto` is a request-time preference and never reaches a
 * provider module. */
export type ResolvedAiProvider = 'palmyra' | 'claude';

export const AI_PROVIDER_LABELS: Record<AiProviderChoice, string> = {
  auto: 'AI: Auto',
  palmyra: 'AI: Palmyra',
  claude: 'AI: Claude',
};

/** Whether Palmyra can serve the surface asking, plus the one sentence the
 * selector shows when the choice needs explaining: why it is blocked, or which
 * credential it spends. `null` means the plain case needs no explanation. */
export interface AiProviderAvailability {
  accountProfile: string;
  resolved: ResolvedAiProvider;
  palmyra: { available: boolean; reason: string | null; model: string };
}

/** Every selector reads and writes the same browser-local default, so choosing
 * Palmyra in the review pane is the same choice the create-task dialog makes.
 * The conversation composer overrides it per conversation, server-side. */
export const AI_PROVIDER_STORAGE_KEY = 'workbench:ai-provider';

export function parseAiProviderChoice(value: unknown): AiProviderChoice {
  const parsed = aiProviderChoiceSchema.safeParse(value);
  return parsed.success ? parsed.data : 'auto';
}
