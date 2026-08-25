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

/** Mirrors the grouped 88px cards in the conversation rail. */
export function ConversationRailSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="conversation-rail-skeleton" aria-hidden="true">
      <div className="stack-header conversation-stack-header skeleton-stack-header"><Skeleton width="72px" height="9px" /><Skeleton width="22px" height="20px" radius="99px" /></div>
      {Array.from({ length: count }, (_, index) => (
        <div className="conversation-skeleton-card" key={index}>
          <div className="conversation-skeleton-title"><Skeleton width="14px" height="14px" radius="99px" /><Skeleton width={index % 2 ? '64%' : '78%'} height="13px" /></div>
          <div className="conversation-skeleton-meta"><Skeleton width="58px" height="16px" radius="99px" /><Skeleton width="48px" height="8px" /></div>
        </div>
      ))}
    </div>
  );
}

/** Mirrors author/time headers and the alternating message-card widths in a thread. */
export function ConversationThreadSkeleton() {
  return (
    <div className="conversation-thread-skeleton" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => {
        const isJeffrey = index === 1 || index === 3;
        return (
          <article className={`shared-message conversation-skeleton-message${isJeffrey ? ' shared-jeffrey' : ''}`} key={index}>
            <header><Skeleton width={isJeffrey ? '26px' : '40px'} height="9px" /><Skeleton width="42px" height="8px" /></header>
            <SkeletonText lines={index === 2 ? 4 : index === 0 ? 3 : 2} width={index === 2 ? '92%' : '78%'} />
          </article>
        );
      })}
    </div>
  );
}

/** Reserves the same editable area and toolbar as the shared conversation composer. */
export function ConversationComposerSkeleton() {
  return (
    <div className="shared-composer conversation-composer-skeleton" aria-hidden="true">
      <div className="conversation-composer-skeleton-body"><Skeleton width="46%" height="13px" /><Skeleton width="72%" height="13px" /></div>
      <div className="composer-toolbar conversation-composer-skeleton-toolbar"><Skeleton width="34px" height="34px" radius="6px" /><Skeleton width="112px" height="34px" radius="7px" /><Skeleton width="92px" height="34px" radius="7px" /><Skeleton width="92px" height="34px" radius="7px" /><Skeleton width="34px" height="34px" radius="7px" /></div>
    </div>
  );
}

export function ConversationSearchResultSkeleton() {
  return (
    <div className="conversation-search-skeleton" aria-hidden="true">
      {[0, 1, 2].map((index) => <div className="conversation-search-skeleton-row" key={index}><Skeleton width={index === 1 ? '58%' : '76%'} height="13px" /><Skeleton width="88%" height="8px" /></div>)}
    </div>
  );
}
