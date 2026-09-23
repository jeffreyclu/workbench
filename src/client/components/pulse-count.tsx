import { useValuePulse } from '../hooks/use-value-pulse';

/** A count badge that briefly pulses when its value changes. */
export function PulseCount({ value, as: Tag = 'strong' }: { value: number; as?: 'strong' | 'span' }) {
  const pulse = useValuePulse(value);
  return <Tag className={pulse}>{value}</Tag>;
}
