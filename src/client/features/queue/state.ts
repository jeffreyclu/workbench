import { useState } from 'react';

export function useQueueSelectionState() {
  return useState<Set<string>>(() => new Set());
}
