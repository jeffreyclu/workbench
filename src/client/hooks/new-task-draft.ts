import { useCallback, useRef, useState } from 'react';
import type { AgentRun } from '../../shared/contracts';
import {
  clearCreatedNewTaskDraft,
  readNewTaskDraft,
  writeNewTaskDraft,
  type NewTaskDraft,
} from '../lib/preferences';

interface NewTaskDraftInitialState {
  mode: 'ai' | 'link';
  aiPrompt?: string;
  sourceUrl?: string;
}

export function useNewTaskDraft(scope: string, defaultProjectName: string, initialState: NewTaskDraftInitialState | null) {
  const [draft, setDraft] = useState<NewTaskDraft>(() => {
    const saved = readNewTaskDraft(scope);
    return {
      mode: initialState?.mode ?? saved?.mode ?? 'manual',
      sourceUrl: initialState?.sourceUrl ?? saved?.sourceUrl ?? '',
      aiPrompt: initialState?.aiPrompt ?? saved?.aiPrompt ?? '',
      title: saved?.title ?? '',
      description: saved?.description ?? '',
      projectName: saved?.projectName ?? defaultProjectName,
      classificationKind: saved?.classificationKind ?? ('execute' satisfies AgentRun['kind']),
    };
  });
  const draftRef = useRef(draft);

  const updateDraft = useCallback((patch: Partial<NewTaskDraft>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    writeNewTaskDraft(scope, next);
    setDraft(next);
  }, [scope]);

  const clearSubmittedDraft = useCallback((submittedDraft: NewTaskDraft) => {
    clearCreatedNewTaskDraft(scope, submittedDraft);
  }, [scope]);

  return { draft, updateDraft, clearSubmittedDraft };
}
