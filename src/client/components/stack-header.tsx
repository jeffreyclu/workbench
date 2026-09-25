import type { TaskStackGroup } from '../lib/stack-view-model';

/**
 * The one stack header for every stack — task queue and conversation rail alike.
 * The number renders through the optically centered path so a digit sits on
 * the circle's true center. Without a known total, only the label renders.
 */
export function StackHeader({ label, count, group, className }: { label: string; count: number | undefined; group: TaskStackGroup; className?: string }) {
  return (
    <div className={['stack-header', `stack-header-${group}`, className].filter(Boolean).join(' ')}>
      <span>{label}</span>
      {count !== undefined && <strong className="optically-centered-count"><span className="optically-centered-number">{count}</span></strong>}
    </div>
  );
}
