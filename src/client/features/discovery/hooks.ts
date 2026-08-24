import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { DiscoveryCandidate } from '../../../shared/contracts';
import { discoveryData, discoveryQueryKeys } from './data';
import { useDiscoveryInboxState } from './state';

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
  const scan = useMutation({ mutationFn: discoveryData.scan, onSuccess: () => invalidateDiscovery(queryClient) });
  const resolveCandidate = useMutation({ mutationFn: ({ candidate, action }: { candidate: DiscoveryCandidate; action: 'convert' | 'dismiss' | 'snooze' }) => discoveryData.resolve(candidate, action), onSuccess: () => invalidateDiscovery(queryClient, true) });
  const bulkResolve = useMutation({ mutationFn: (action: 'convert' | 'dismiss' | 'snooze') => discoveryData.bulkResolve([...selected], action), onSuccess: () => { setSelected(new Set()); invalidateDiscovery(queryClient, true); } });
  const restore = useMutation({ mutationFn: discoveryData.restore, onSuccess: () => invalidateDiscovery(queryClient) });
  return { inboxView, setInboxView, selected, setSelected, inbox, activeTasks, scan, resolveCandidate, bulkResolve, restore, resolveMerge: (id: string, workItemId: string) => discoveryData.resolveMerge(id, workItemId).then(() => invalidateDiscovery(queryClient)) };
}

export function useDiscoveryCard(candidate: DiscoveryCandidate) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(candidate.title);
  const [description, setDescription] = useState(candidate.description);
  const [mergeTarget, setMergeTarget] = useState('');
  const update = useMutation({ mutationFn: () => discoveryData.update(candidate.id, { title: title.trim(), description }), onSuccess: () => { setEditing(false); invalidateDiscovery(queryClient); } });
  return { editing, setEditing, title, setTitle, description, setDescription, mergeTarget, setMergeTarget, update };
}
