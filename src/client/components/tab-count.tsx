/** The number shown beside a tab or navigation label. Blank until counts load. */
export function TabCount({ value }: { value: number | undefined }) {
  return <span className="tab-count" aria-hidden={value === undefined}>{value ?? ''}</span>;
}
