import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { DiscoveryCandidate } from '../../../shared/contracts';
import { toast, toastError } from '../../toast-store';
import { discoveryData, discoveryQueryKeys } from './data';
import { useDiscoveryInboxState } from './state';

const ACTION_VERBS: Record<'convert' | 'dismiss' | 'snooze', string> = { convert: 'add', dismiss: 'dismiss', snooze: 'snooze' };
const ACTION_MESSAGES: Record<'convert' | 'dismiss' | 'snooze', string> = { convert: 'Added to stack.', dismiss: 'Discovery dismissed.', snooze: 'Snoozed until tomorrow.' };

function invalidateDiscovery(queryClient: ReturnType<typeof useQueryClient>, includeWorkItems = false) {
  void queryClient.invalidateQueries({ queryKey: discoveryQueryKeys.root });
  if (includeWorkItems) {
    void queryClient.invalidateQueries({ queryKey: ['work-items'] });
    void queryClient.invalidateQueries({ queryKey: ['work-item-counts'] });
  }
}

export function useDiscoveryNav() {
  return useQuery({ queryKey: discoveryQueryKeys.inbox('pending'), queryFn: () => discoveryData.getInbox('pending'), refetchInterval: 10_000 });
}

export function useDiscoveryInbox() {
  const queryClient = useQueryClient();
  const { inboxView, setInboxView, selected, setSelected } = useDiscoveryInboxState();
  const inbox = useQuery({ queryKey: discoveryQueryKeys.inbox(inboxView), queryFn: () => discoveryData.getInbox(inboxView), refetchInterval: 10_000 });
  const activeTasks = useQuery({ queryKey: discoveryQueryKeys.mergeTargets, queryFn: discoveryData.getMergeTargets });
  const scan = useMutation({
    mutationFn: discoveryData.scan,
    onSuccess: () => invalidateDiscovery(queryClient),
    onError: (error) => toastError('Could not start the discovery scan.', error),
  });
  const resolveCandidate = useMutation({
    mutationFn: ({ candidate, action }: { candidate: DiscoveryCandidate; action: 'convert' | 'dismiss' | 'snooze' }) => discoveryData.resolve(candidate, action),
    onSuccess: (_result, { candidate, action }) => {
      invalidateDiscovery(queryClient, true);
      toast.success(ACTION_MESSAGES[action], { action: () => restore.mutate(candidate.id), actionLabel: 'Undo', duration: 5_000 });
    },
    onError: (error, { candidate, action }) => toastError(`Could not ${ACTION_VERBS[action]} "${candidate.title}".`, error),
  });
  const bulkResolve = useMutation({
    mutationFn: (action: 'convert' | 'dismiss' | 'snooze') => discoveryData.bulkResolve([...selected], action).then((result) => ({ result, action, requested: new Set(selected) })),
    onSuccess: ({ result, action, requested }) => {
      const resolvedIds = new Set(result.candidates.map((candidate) => candidate.id));
      const failedCount = requested.size - resolvedIds.size;
      setSelected(new Set([...requested].filter((id) => !resolvedIds.has(id))));
      invalidateDiscovery(queryClient, true);
      if (failedCount > 0) toast.error(`${resolvedIds.size} of ${requested.size} discoveries ${ACTION_VERBS[action]}ed; ${failedCount} could not be resolved and stay selected.`);
    },
    onError: (error) => toastError('Could not complete the bulk review action; the selection was left unchanged.', error),
  });
  const restore = useMutation({
    mutationFn: discoveryData.restore,
    onSuccess: () => invalidateDiscovery(queryClient, true),
    onError: (error) => toastError('Could not restore this discovery.', error),
  });
  const resolveMerge = useMutation({
    mutationFn: ({ id, workItemId }: { id: string; workItemId: string }) => discoveryData.resolveMerge(id, workItemId),
    onSuccess: () => invalidateDiscovery(queryClient),
    onError: (error) => toastError('Could not merge this discovery into the task.', error),
  });
  return {
    inboxView, setInboxView, selected, setSelected, inbox, activeTasks, scan, resolveCandidate, bulkResolve, restore, resolveMerge,
  };
}

export function useDiscoveryCard(candidate: DiscoveryCandidate) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(candidate.title);
  const [description, setDescription] = useState(candidate.description);
  const [mergeTarget, setMergeTarget] = useState('');
  const update = useMutation({
    mutationFn: () => discoveryData.update(candidate.id, { title: title.trim(), description }),
    onSuccess: () => { setEditing(false); invalidateDiscovery(queryClient); },
    onError: (error) => toastError('Could not save changes to this discovery.', error),
  });
  return { editing, setEditing, title, setTitle, description, setDescription, mergeTarget, setMergeTarget, update };
}
