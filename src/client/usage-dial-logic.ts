/** Percent of `ceilingSet` consumed by `usedSet`, or null when no ceiling estimate exists yet. */
export function percentOfCeiling(usedSet: number, ceilingSet: number | null): number | null {
  if (ceilingSet === null || ceilingSet <= 0) return null;
  return (usedSet / ceilingSet) * 100;
}

/** Share of `totalSet` contributed by `partSet`, for the manual/autonomous split within a provider's bar. Null when there's nothing to split. */
export function shareOfTotal(partSet: number, totalSet: number): number | null {
  if (totalSet <= 0) return null;
  return (partSet / totalSet) * 100;
}

/** Whole days between `now` and `target` (in the future), floored at 0 so a passed deadline never reads as negative. */
export function daysRemaining(target: string, now: Date): number {
  const ms = new Date(target).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}
