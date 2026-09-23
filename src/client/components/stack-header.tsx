import type { TaskStackGroup } from '../lib/stack-view-model';

/**
 * The one stack header for every stack — task queue and conversation rail alike.
 * The count badge always renders through the optically centered path so a digit
 * sits on the circle's true center instead of its font baseline box. Remounting
 * on a count-keyed key restarts the pulse animation without tracking state.
 */
export function StackHeader({ label, count, group, className }: { label: string; count: number; group: TaskStackGroup; className?: string }) {
  return (
    <div className={['stack-header', `stack-header-${group}`, className].filter(Boolean).join(' ')}>
      <span>{label}</span>
      <strong key={count} className="optically-centered-count count-badge"><span className="optically-centered-number">{count}</span></strong>
    </div>
  );
}
