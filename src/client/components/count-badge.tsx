/**
 * A count display that re-triggers its scale-in animation whenever the value
 * changes, by remounting on a value-keyed key rather than tracking pulse
 * state — CSS drives the motion, not a timeout.
 */
export function CountBadge({ value, as: Tag = 'strong', className }: { value: number | undefined; as?: 'strong' | 'span'; className?: string }) {
  return (
    <Tag key={value ?? 'pending'} className={['count-badge', className].filter(Boolean).join(' ')}>
      {value ?? '…'}
    </Tag>
  );
}
