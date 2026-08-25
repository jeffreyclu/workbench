import { useEffect, useRef, useState } from 'react';

/** Returns 'value-pulse' for a brief moment whenever `value` changes, for count/badge feedback. */
export function useValuePulse(value: unknown) {
  const previous = useRef(value);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setPulsing(true);
    const timer = window.setTimeout(() => setPulsing(false), 260);
    return () => window.clearTimeout(timer);
  }, [value]);

  return pulsing ? 'value-pulse' : '';
}
