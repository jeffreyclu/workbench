import { z } from 'zod';
import type { RuntimeCapabilities } from './runtime-capabilities.js';

const followUpPlanSchema = z.object({
  summary: z.string().trim().min(1).max(20_000),
  tasks: z.array(z.object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(20_000),
    workspacePath: z.string().trim().max(1_000).nullable(),
  })).min(1).max(100),
});

/** Agents sometimes omit the requested XML wrapper but still return valid JSON. */
export function parseFollowUpPlan(output: string): z.infer<typeof followUpPlanSchema> {
  const wrapped = output.match(/<workbench-plan>([\s\S]*?)<\/workbench-plan>/)?.[1];
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (wrapped ?? fenced ?? output).trim();
  return followUpPlanSchema.parse(JSON.parse(candidate));
}

/** Return the configured public OAuth base without trusting the request Host header. */
export function oauthCallbackBase(): string {
  const configured = process.env.APP_API_ORIGIN?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'http:' || url.protocol === 'https:') return configured;
    } catch { /* falls through to the local origin */ }
  }
  return `http://localhost:${process.env.PORT ?? 4317}/api/source-connections`;
}

export function rejectPreviewMutation(method: string, capabilities: RuntimeCapabilities): { error: string; code: string } | null {
  if (capabilities.allowMutations || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  return { error: 'Preview is read-only. Run this action from the live Workbench.', code: 'PREVIEW_READ_ONLY' };
}
