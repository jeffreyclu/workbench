import type { WorkItem } from '../shared/contracts.js';
import { resolveBrokerUrl } from './connection-broker.js';
import type { WorkItemRepository } from './repository.js';

const linearIdentifier = (value: string | null | undefined) =>
  value?.match(/linear\.app\/[^\s]*\/issue\/([A-Za-z]+-\d+)/i)?.[1]?.toUpperCase() ?? null;

export function needsAuthoritativeWorkItemGrounding(item: WorkItem): boolean {
  return Boolean(linearIdentifier(item.sourceUrl)) && (
    item.title.trim().toLowerCase() === 'linear'
    || /^context from linear:/i.test(item.description.trim())
    || !item.sourceIdentifier
  );
}

/**
 * Resolve authoritative linked-task content before persona, repository, or
 * workspace selection. The stored manual card may remain a lightweight link;
 * every execution receives the current provider-backed task invariant.
 */
export async function groundAuthoritativeWorkItem(repository: WorkItemRepository, item: WorkItem): Promise<WorkItem> {
  if (!needsAuthoritativeWorkItemGrounding(item)) return item;
  const identifier = linearIdentifier(item.sourceUrl)!;
  let draft;
  try {
    draft = await resolveBrokerUrl(repository, item.sourceUrl!);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Authoritative Linear ticket ${identifier} could not be resolved before repository routing: ${reason}`);
  }
  const providerItem = repository.searchLinear(identifier, 20)
    .find((candidate) => candidate.sourceIdentifier?.toUpperCase() === identifier);
  return {
    ...item,
    title: draft.title,
    description: draft.description,
    source: 'linear',
    sourceIdentifier: identifier,
    sourceUrl: draft.sourceUrl,
    projectName: providerItem?.projectName ?? item.projectName,
    labels: providerItem?.labels ?? item.labels,
  };
}
