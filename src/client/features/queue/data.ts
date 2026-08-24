export const queueQueryKeys = {
  workItems: ['work-items'] as const,
  workItem: (itemId: string) => ['work-item', itemId] as const,
};
