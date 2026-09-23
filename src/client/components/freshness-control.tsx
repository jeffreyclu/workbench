import { LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

function relativeFreshness(updatedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1_000));
  if (seconds < 10) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours / 24)}d ago`;
}

export function FreshnessControl({ updatedAt, isRefreshing, onRefresh }: { updatedAt: number; isRefreshing: boolean; onRefresh: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(interval);
  }, [updatedAt]);
  if (!updatedAt) return null;
  return <div className="freshness-control">
    <time dateTime={new Date(updatedAt).toISOString()} aria-live="polite">{relativeFreshness(updatedAt, now)}</time>
    <button type="button" className="button secondary compact" onClick={onRefresh} disabled={isRefreshing}>
      {isRefreshing ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} Refresh
    </button>
  </div>;
}
