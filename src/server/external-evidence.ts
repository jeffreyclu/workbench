import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ExternalEvidenceSnapshot } from '../shared/contracts.js';
import type { WorkItemRepository } from './repository.js';

export interface ExternalEvidence<T> {
  snapshot: ExternalEvidenceSnapshot;
  payload: T;
  reused: boolean;
}

const inFlight = new Map<string, Promise<ExternalEvidence<unknown>>>();

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function externalEvidenceRequestKey(kind: string, request: unknown): string {
  return createHash('sha256').update(`${kind}\n${stable(request)}`).digest('hex');
}

function evidenceRoot(): string {
  const databasePath = resolve(process.env.DATABASE_PATH?.trim() || './data/workbench.db');
  return join(dirname(databasePath), 'external-evidence');
}

async function readPayload<T>(snapshot: ExternalEvidenceSnapshot): Promise<T> {
  return JSON.parse(await readFile(snapshot.payloadPath, 'utf8')) as T;
}

/** Fetch once for one human dispatch, atomically persist the exact result to
 * local disk, and return that same immutable snapshot to every paired agent. */
export async function brokerExternalEvidence<T>(
  repository: WorkItemRepository,
  input: { conversationId: string; dispatchGroupId: string; kind: string; source: string; request: unknown },
  fetcher: () => Promise<T>,
): Promise<ExternalEvidence<T>> {
  const requestKey = externalEvidenceRequestKey(input.kind, input.request);
  // Exact evidence is conversation truth. A follow-up or provider retry must
  // read the original bytes rather than silently observing a newer upstream
  // state. A changed URL/query gets a changed key and therefore a fresh read.
  const existing = repository.getExternalEvidenceSnapshot(input.dispatchGroupId, requestKey)
    ?? repository.getConversationExternalEvidenceSnapshot(input.conversationId, requestKey);
  if (existing) return { snapshot: existing, payload: await readPayload<T>(existing), reused: true };

  const flightKey = `${input.dispatchGroupId}:${requestKey}`;
  const active = inFlight.get(flightKey);
  if (active) return active as Promise<ExternalEvidence<T>>;

  const operation = (async () => {
    const conversationDirectory = join(evidenceRoot(), input.conversationId);
    const directory = join(conversationDirectory, input.dispatchGroupId);
    const payloadPath = join(directory, `${requestKey}.json`);
    await mkdir(directory, { recursive: true });
    const lockPath = join(conversationDirectory, `${requestKey}.lock`);
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Another serving runtime owns this exact fetch. Wait for its durable
      // manifest instead of hitting the provider a second time.
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        const completed = repository.getExternalEvidenceSnapshot(input.dispatchGroupId, requestKey)
          ?? repository.getConversationExternalEvidenceSnapshot(input.conversationId, requestKey);
        if (completed) return { snapshot: completed, payload: await readPayload<T>(completed), reused: true };
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      // The owner died before writing a manifest. Clear only this exact
      // request's lock so a later retry can recover instead of being wedged.
      await unlink(lockPath).catch(() => undefined);
      throw new Error(`Supervisor evidence fetch did not finish for ${input.source}.`);
    }

    try {
      // A different process may have completed between our first lookup and
      // lock acquisition. Check again before spending a provider request.
      const completed = repository.getExternalEvidenceSnapshot(input.dispatchGroupId, requestKey)
        ?? repository.getConversationExternalEvidenceSnapshot(input.conversationId, requestKey);
      if (completed) return { snapshot: completed, payload: await readPayload<T>(completed), reused: true };
      const payload = await fetcher();
      const serialized = `${JSON.stringify(payload, null, 2)}\n`;
      const payloadHash = createHash('sha256').update(serialized).digest('hex');
      const temporaryPath = `${payloadPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, payloadPath);
      const snapshot = repository.createExternalEvidenceSnapshot({ ...input, requestKey, payloadPath, payloadHash });
      return { snapshot, payload, reused: false };
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  })();
  inFlight.set(flightKey, operation as Promise<ExternalEvidence<unknown>>);
  try { return await operation; }
  finally { inFlight.delete(flightKey); }
}

export function evidencePromptBlock(evidence: ExternalEvidence<unknown>[]): string {
  if (!evidence.length) return '';
  return `Supervisor-owned external evidence (authoritative for this turn):\n${evidence.map(({ snapshot }) => `- ${snapshot.kind}: ${snapshot.source}\n  Local immutable snapshot: ${snapshot.payloadPath}\n  SHA-256: ${snapshot.payloadHash}`).join('\n')}\nUse these local snapshots directly. Do not independently fetch, search, clone, pull, or reconstruct the same external source. If more external evidence is required, use a Workbench evidence tool with this conversation and reply message ID so the supervisor can cache and share it.`;
}
