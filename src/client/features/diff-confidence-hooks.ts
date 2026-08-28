import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../data/api.js';
import { subscribeRealtimeMessages } from '../hooks/realtime.js';
import { boundConfidenceRequestBlocks } from './diff-confidence.js';
import { HIGH_RISK_THRESHOLD } from './diff-review-logic.js';

// One block per request lets the WebSocket publish each assessment as it
// finishes. A slow block must never hold its faster siblings hostage.
const SCORE_BATCH_SIZE = 1;
// A worker that times out or dies answers 200 with a null risk. Retrying that
// transient failure is what keeps a long review from ending with a handful of
// permanently unscored decisions.
const SCORE_ATTEMPTS = 3;
type Block = { key: string; lines: string[] };
type Assessment = { risk: number | null; reasoning: string };

/** Scores small groups independently. Results arrive over the shared WebSocket
 * as each group completes; HTTPS remains the recovery path when WS is down. */
export function useDiffBlockConfidence(blocks: Block[]) {
  // Requests are bounded to the server's contract, so an oversized hunk or a
  // long grouped decision key is scored rather than rejected wholesale.
  const { batches, sourceKeyByRequestKey } = useMemo(() => {
    const bounded = boundConfidenceRequestBlocks(blocks);
    const result: Block[][] = [];
    for (let index = 0; index < bounded.requests.length; index += SCORE_BATCH_SIZE) result.push(bounded.requests.slice(index, index + SCORE_BATCH_SIZE));
    return { batches: result, sourceKeyByRequestKey: bounded.sourceKeyByRequestKey };
  }, [blocks]);
  const [streamed, setStreamed] = useState<Record<string, Assessment>>({});
  const queries = useQueries({
    queries: batches.map((batch) => ({
      queryKey: ['diff-confidence', JSON.stringify(batch)],
      queryFn: async () => {
        const result = await api.assessDiffBlocks(batch);
        const assessments = result.assessments ?? {};
        // An unscored block is a failure, not a result: caching it would leave
        // the decision reading "unavailable" for the rest of the session.
        if (batch.some((block) => typeof assessments[block.key]?.risk !== 'number')) throw new Error('AI diff assessment incomplete.');
        return assessments;
      },
      staleTime: Infinity,
      retry: SCORE_ATTEMPTS - 1,
      retryDelay: (attempt: number) => Math.min(4_000, 500 * 2 ** attempt),
    })),
  });

  useEffect(() => {
    setStreamed({});
    return subscribeRealtimeMessages((message) => {
      if (message.type !== 'diff-confidence') return;
      const matching: Record<string, Assessment> = {};
      for (const [requestKey, assessment] of Object.entries(message.assessments)) {
        const sourceKey = sourceKeyByRequestKey[requestKey];
        if (sourceKey && typeof assessment.risk === 'number') matching[sourceKey] = assessment;
      }
      if (Object.keys(matching).length) setStreamed((current) => ({ ...current, ...matching }));
    });
  }, [sourceKeyByRequestKey]);

  const fetched: Record<string, Assessment> = {};
  for (const query of queries) {
    for (const [requestKey, assessment] of Object.entries(query.data ?? {})) {
      const sourceKey = sourceKeyByRequestKey[requestKey];
      if (sourceKey) fetched[sourceKey] = assessment as Assessment;
    }
  }
  const data = { ...fetched, ...streamed } as Record<string, Assessment>;
  // Only a query that has exhausted its retries counts as failed; one still
  // retrying stays in the pending state so the queue keeps showing "scoring".
  const failedKeys = new Set(batches.flatMap((batch, index) => queries[index]?.isError
    ? batch.map((block) => sourceKeyByRequestKey[block.key] ?? block.key).filter((key) => !(key in data))
    : []));
  return { data, failedKeys };
}

export interface FlaggedBlock {
  path: string;
  blockKey: string;
}

/** Diff-level risk rollup: per-file max risk for the file nav, plus the
 * ordered list of high-risk blocks the summary strip counts and the
 * "next flagged block" jump navigates through. Block keys are namespaced per
 * file since `groupDiffBlocks` keys are only unique within one file's patch. */
export function useDiffRiskSummary(files: Array<{ path: string; blocks: Block[] }>) {
  const namespacedBlocks = useMemo(
    () => files.flatMap((file) => file.blocks.map((block) => ({ key: `${file.path}::${block.key}`, lines: block.lines }))),
    [files],
  );
  const confidence = useDiffBlockConfidence(namespacedBlocks);
  return useMemo(() => {
    const riskByFile = new Map<string, number | null>();
    const flaggedBlocks: FlaggedBlock[] = [];
    for (const file of files) {
      let maxRisk: number | null = null;
      for (const block of file.blocks) {
        const risk = confidence.data[`${file.path}::${block.key}`]?.risk;
        if (typeof risk === 'number' && (maxRisk === null || risk > maxRisk)) maxRisk = risk;
        if (typeof risk === 'number' && risk >= HIGH_RISK_THRESHOLD) flaggedBlocks.push({ path: file.path, blockKey: block.key });
      }
      riskByFile.set(file.path, maxRisk);
    }
    return { riskByFile, flaggedBlocks };
  }, [files, confidence.data]);
}
