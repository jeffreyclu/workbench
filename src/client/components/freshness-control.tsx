import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

function relativeFreshness(updatedAt: number, now: number, compact = false): string {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1_000));
  if (seconds < 10) return compact ? 'Now' : 'Updated just now';
  if (seconds < 60) return compact ? `${seconds}s` : `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return compact ? `${minutes}m` : `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return compact ? `${hours}h` : `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return compact ? `${days}d` : `Updated ${days}d ago`;
}

export function FreshnessControl({ updatedAt, isRefreshing, onRefresh, compact = false }: { updatedAt: number; isRefreshing: boolean; onRefresh: () => void; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(interval);
  }, [updatedAt]);
  if (!updatedAt) return null;
  const label = relativeFreshness(updatedAt, now, compact);
  return <button
    type="button"
    className={`freshness-control${isRefreshing ? ' is-refreshing' : ''}`}
    onClick={onRefresh}
    disabled={isRefreshing}
    aria-label={isRefreshing ? `Refreshing data. ${label}` : `Refresh data. ${label}`}
  >
    <span className="freshness-status" aria-hidden="true" />
    <time dateTime={new Date(updatedAt).toISOString()} aria-live="polite">{label}</time>
    <RefreshCw className={isRefreshing ? 'spin' : undefined} size={12} aria-hidden="true" />
  </button>;
}
