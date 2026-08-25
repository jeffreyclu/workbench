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

/** Mirrors grouped task cards, including their project marker, copy, and metadata. */
export function TaskQueueSkeleton({ count = 6 }: { count?: number }) {
  return <div className="task-queue-skeleton" aria-hidden="true">
    <div className="stack-header skeleton-stack-header"><Skeleton width="76px" height="9px" /><Skeleton width="18px" height="18px" radius="99px" /></div>
    {Array.from({ length: count }, (_, index) => <div className="queue-item task-queue-skeleton-card" key={index}>
      <Skeleton width="18px" height="18px" radius="99px" />
      <div className="task-queue-skeleton-copy"><Skeleton width={index % 3 === 0 ? '82%' : '68%'} height="13px" /><Skeleton width="48%" height="8px" /><div><Skeleton width="54px" height="16px" radius="99px" /><Skeleton width="42px" height="16px" radius="99px" /></div></div>
    </div>)}
  </div>;
}

/** Preserves the task detail panel's title, metadata, and section rhythm. */
export function TaskDetailSkeleton() {
  return <section className="detail-panel detail-skeleton" aria-hidden="true">
    <div className="detail-skeleton-topline"><Skeleton width="88px" height="10px" /><Skeleton width="112px" height="30px" radius="7px" /></div>
    <Skeleton width="min(680px, 88%)" height="42px" /><div className="detail-skeleton-meta"><Skeleton width="70px" height="20px" radius="99px" /><Skeleton width="88px" height="20px" radius="99px" /><Skeleton width="60px" height="20px" radius="99px" /></div>
    {[3, 2, 3].map((lines, index) => <div className="detail-section detail-skeleton-section" key={index}><Skeleton width="96px" height="9px" />{Array.from({ length: lines }, (_, line) => <Skeleton key={line} width={line === lines - 1 ? '62%' : '100%'} height="11px" />)}</div>)}
  </section>;
}

export function DiscoveryCardSkeleton({ count = 5 }: { count?: number }) {
  return <div className="discovery-card-skeletons" aria-hidden="true">{Array.from({ length: count }, (_, index) => <article className="discovery-card discovery-card-skeleton" key={index}><div className="discovery-skeleton-source"><Skeleton width="84px" height="9px" /><Skeleton width="86px" height="9px" /></div><Skeleton width={index % 2 ? '66%' : '78%'} height="19px" /><SkeletonText lines={2} /><div className="discovery-skeleton-actions"><Skeleton width="80px" height="28px" radius="6px" /><Skeleton width="72px" height="28px" radius="6px" /><Skeleton width="96px" height="28px" radius="6px" /></div></article>)}</div>;
}

export function ArtifactCardSkeleton({ count = 5 }: { count?: number }) {
  return <div className="artifact-card-skeletons" aria-hidden="true">{Array.from({ length: count }, (_, index) => <article className="artifact-card artifact-card-skeleton" key={index}><div className="artifact-skeleton-header"><Skeleton width="14px" height="14px" radius="3px" /><Skeleton width={index % 2 ? '52%' : '68%'} height="15px" /><Skeleton width="34px" height="18px" radius="4px" /></div><div className="artifact-meta"><Skeleton width="118px" height="10px" /><Skeleton width="64px" height="10px" /></div><Skeleton width="42%" height="38px" radius="6px" /><div className="artifact-skeleton-actions"><Skeleton width="74px" height="28px" radius="6px" /><Skeleton width="88px" height="28px" radius="6px" /></div></article>)}</div>;
}

export function ArtifactDetailSkeleton() {
  return <div className="artifact-detail artifact-detail-skeleton" aria-hidden="true"><Skeleton width="74%" height="10px" />{[2, 3, 2].map((rows, index) => <div className="artifact-skeleton-section" key={index}><Skeleton width="100px" height="9px" />{Array.from({ length: rows }, (_, row) => <Skeleton key={row} width={row === rows - 1 ? '58%' : '100%'} height="12px" />)}</div>)}</div>;
}

export function CandidateRowSkeleton({ count = 3 }: { count?: number }) {
  return <ul className="dependency-candidates candidate-row-skeleton" aria-hidden="true">{Array.from({ length: count }, (_, index) => <li key={index}><div><Skeleton width="12px" height="12px" radius="3px" /><Skeleton width={index === count - 1 ? '48%' : '68%'} height="11px" /><Skeleton width="56px" height="9px" /></div></li>)}</ul>;
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
