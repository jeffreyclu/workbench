import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../data/api.js';
import { subscribeRealtimeMessages } from '../hooks/realtime.js';
import { HIGH_RISK_THRESHOLD } from './diff-review-logic.js';

const SCORE_BATCH_SIZE = 3;
type Block = { key: string; lines: string[] };
type Assessment = { risk: number | null; reasoning: string };

/** Scores small groups independently. Results arrive over the shared WebSocket
 * as each group completes; HTTPS remains the recovery path when WS is down. */
export function useDiffBlockConfidence(blocks: Block[]) {
  const batches = useMemo(() => {
    const result: Block[][] = [];
    for (let index = 0; index < blocks.length; index += SCORE_BATCH_SIZE) result.push(blocks.slice(index, index + SCORE_BATCH_SIZE));
    return result;
  }, [blocks]);
  const keys = useMemo(() => new Set(blocks.map((block) => block.key)), [blocks]);
  const [streamed, setStreamed] = useState<Record<string, Assessment>>({});
  const queries = useQueries({
    queries: batches.map((batch) => ({
      queryKey: ['diff-confidence', JSON.stringify(batch)],
      queryFn: () => api.assessDiffBlocks(batch),
      staleTime: Infinity,
      retry: false,
      select: (result: { assessments: Record<string, Assessment> }) => result.assessments ?? {},
    })),
  });

  useEffect(() => {
    setStreamed({});
    return subscribeRealtimeMessages((message) => {
      if (message.type !== 'diff-confidence') return;
      const matching = Object.fromEntries(Object.entries(message.assessments).filter(([key]) => keys.has(key)));
      if (Object.keys(matching).length) setStreamed((current) => ({ ...current, ...matching }));
    });
  }, [keys]);

  const data = { ...Object.assign({}, ...queries.map((query) => query.data ?? {})), ...streamed } as Record<string, Assessment>;
  const failedKeys = new Set(batches.flatMap((batch, index) => queries[index]?.isError ? batch.map((block) => block.key) : []));
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
