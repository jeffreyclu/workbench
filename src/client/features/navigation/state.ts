import { useEffect, useState } from 'react';

export function useMobileNavigationState() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [isCompactNav, setIsCompactNav] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 820px)').matches);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(max-width: 820px)');
    const handleChange = (event: MediaQueryListEvent) => setIsCompactNav(event.matches);
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, []);

  return { mobileNavOpen, setMobileNavOpen, isCompactNav };
}
