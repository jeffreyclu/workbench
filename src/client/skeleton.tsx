/** A placeholder block that mimics the size of the content it precedes, so loading doesn't shift layout. */
export function Skeleton({ width, height = '1em', radius, className = '' }: { width?: string | number; height?: string | number; radius?: string; className?: string }) {
  return (
    <span
      className={`skeleton ${className}`}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

export function SkeletonText({ lines = 1, width }: { lines?: number; width?: string | number }) {
  return (
    <span className="skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} width={width ?? (index === lines - 1 && lines > 1 ? '70%' : '100%')} />
      ))}
    </span>
  );
}

export function UsageDialSkeleton() {
  return (
    <div className="insight-section usage-dial-section" aria-hidden="true">
      <Skeleton width="140px" height="1.1em" />
      <Skeleton width="90%" height="0.85em" />
      <div className="usage-dial-grid">
        {[0, 1].map((index) => (
          <article className="usage-dial-card" key={index}>
            <header>
              <Skeleton width="70px" height="1em" />
              <Skeleton width="90px" height="0.85em" />
            </header>
            <Skeleton width="100%" height="10px" radius="6px" />
            <dl className="usage-dial-breakdown">
              <div><Skeleton width="50px" /><Skeleton width="60px" /></div>
              <div><Skeleton width="70px" /><Skeleton width="60px" /></div>
            </dl>
          </article>
        ))}
      </div>
    </div>
  );
}

export function InsightsSkeleton() {
  return (
    <div className="insight-sections" aria-hidden="true">
      <UsageDialSkeleton />
      <div className="insight-overall-row">
        {[0, 1, 2, 3].map((index) => (
          <div className="insight-overall-stat" key={index}>
            <Skeleton width="120px" height="0.75em" />
            <Skeleton width="60px" height="1.6em" />
            <Skeleton width="90%" height="0.8em" />
          </div>
        ))}
      </div>
      <div className="insight-section">
        <Skeleton width="200px" height="1.1em" />
        <SkeletonText lines={3} />
      </div>
      <div className="insight-section">
        <Skeleton width="220px" height="1.1em" />
        <div className="insight-agent-grid">
          {[0, 1].map((index) => (
            <article className="insight-agent-card" key={index}>
              <header><Skeleton width="80px" /><Skeleton width="50px" /></header>
              <SkeletonText lines={3} />
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ListRowSkeleton({ count = 5, className = '' }: { count?: number; className?: string }) {
  return (
    <div className={`list-state-skeleton ${className}`} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton-list-row" key={index}>
          <Skeleton width="60%" height="0.95em" />
          <Skeleton width="30%" height="0.8em" />
        </div>
      ))}
    </div>
  );
}
