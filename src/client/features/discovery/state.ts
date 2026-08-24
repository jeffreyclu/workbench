import { useState } from 'react';

export function useDiscoveryInboxState() {
  const [inboxView, setInboxView] = useState<'pending' | 'reviewed'>('pending');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return { inboxView, setInboxView, selected, setSelected };
}
