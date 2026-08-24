import type { WeeklyUsageReport } from '../shared/contracts';

/** Percent of `ceilingSet` consumed by `usedSet`, or null when no ceiling estimate exists yet. */
export function percentOfCeiling(usedSet: number, ceilingSet: number | null): number | null {
  if (ceilingSet === null || ceilingSet <= 0) return null;
  return (usedSet / ceilingSet) * 100;
}

/** Share of `totalSet` contributed by `partSet`, for the manual/autonomous split within a provider's bar. Null when there's nothing to split. */
export function shareOfTotal(partSet: number, totalSet: number): number | null {
  if (totalSet <= 0) return null;
  return (partSet / totalSet) * 100;
}

/** Whole days between `now` and `target` (in the future), floored at 0 so a passed deadline never reads as negative. */
export function daysRemaining(target: string, now: Date): number {
  const ms = new Date(target).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

function formatSet(setTokens: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.round(setTokens));
}

function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

const shortDateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const weekdayTimeFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** "Estimate — not yet calibrated" until a `/usage` observation lands, then "Calibrated {date}" (see docs/autonomy-strategy.md "Calibration"). */
function CalibrationLabel({ calibration }: { calibration: WeeklyUsageReport['claude']['calibration'] }) {
  if (!calibration) return <span className="usage-dial-calibration usage-dial-calibration-estimate">Estimate — not yet calibrated</span>;
  return <span className="usage-dial-calibration usage-dial-calibration-calibrated">Calibrated {shortDateFormat.format(new Date(calibration.observedAt))}</span>;
}

function ProviderDial({ label, manualSet, autonomousSet, extraSet, extraLabel, ceilingSet, autonomousTargetFraction, autonomousSliceFraction, rateLimit, calibration, weekEnd, now }: {
  label: string;
  manualSet: number;
  autonomousSet: number;
  extraSet?: number;
  extraLabel?: string;
  ceilingSet: number | null;
  autonomousTargetFraction: number;
  autonomousSliceFraction: number;
  rateLimit?: WeeklyUsageReport['codex']['rateLimit'];
  calibration: WeeklyUsageReport['claude']['calibration'];
  weekEnd: string;
  now: Date;
}) {
  const totalSet = manualSet + autonomousSet + (extraSet ?? 0);
  const usedPercent = rateLimit ? rateLimit.usedPercent : percentOfCeiling(totalSet, ceilingSet);
  const manualPercentOfCeiling = percentOfCeiling(manualSet, ceilingSet);
  const autonomousPercentOfCeiling = percentOfCeiling(autonomousSet, ceilingSet);
  const extraPercentOfCeiling = extraSet ? percentOfCeiling(extraSet, ceilingSet) : null;
  const targetMarkerPercent = autonomousTargetFraction * 100;
  const alarmMarkerPercent = autonomousSliceFraction * 100;
  const note = !rateLimit && ceilingSet === null ? `No ${label} ceiling estimate yet — showing raw usage only.` : null;

  const resetNote = rateLimit?.resetsAt
    ? `Resets ${weekdayTimeFormat.format(new Date(rateLimit.resetsAt))} · ${daysRemaining(rateLimit.resetsAt, now)}d left`
    : `Workbench week ends ${weekdayTimeFormat.format(new Date(weekEnd))} · ${daysRemaining(weekEnd, now)}d left`;

  return (
    <article className="usage-dial-card">
      <header>
        <strong>{label}</strong>
        <span className="usage-dial-total">{rateLimit ? `${formatPercent(usedPercent)} used` : `${formatPercent(usedPercent)} of weekly ceiling`}</span>
      </header>
      {note && <p className="insight-empty-note">{note}</p>}
      {usedPercent !== null && (
        <div className="usage-dial-track" role="img" aria-label={`${label}: ${formatPercent(usedPercent)} used${rateLimit ? '' : `, ${formatPercent(manualPercentOfCeiling)} manual, ${formatPercent(autonomousPercentOfCeiling)} autonomous. Autonomous target ${formatPercent(targetMarkerPercent)}, alarm ${formatPercent(alarmMarkerPercent)}`}`}>
          {rateLimit ? (
            <div className="usage-dial-fill usage-dial-fill-manual" style={{ width: `${Math.min(100, usedPercent)}%` }} />
          ) : (
            <>
              <div className="usage-dial-fill usage-dial-fill-manual" style={{ width: `${Math.min(100, manualPercentOfCeiling ?? 0)}%` }} />
              <div className="usage-dial-fill usage-dial-fill-autonomous" style={{ width: `${Math.min(100, autonomousPercentOfCeiling ?? 0)}%` }} />
              {extraPercentOfCeiling !== null && <div className="usage-dial-fill usage-dial-fill-interactive" style={{ width: `${Math.min(100, extraPercentOfCeiling)}%` }} />}
            </>
          )}
          <div className="usage-dial-slice-marker usage-dial-slice-marker-target" style={{ left: `${Math.min(100, targetMarkerPercent)}%` }} title={`${formatPercent(targetMarkerPercent)} autonomous target`} />
          <div className="usage-dial-slice-marker usage-dial-slice-marker-alarm" style={{ left: `${Math.min(100, alarmMarkerPercent)}%` }} title={`${formatPercent(alarmMarkerPercent)} autonomous alarm`} />
        </div>
      )}
      <div className="usage-dial-marker-legend">
        <span><span className="usage-dial-marker-swatch usage-dial-marker-swatch-target" />Target {formatPercent(targetMarkerPercent)}</span>
        <span><span className="usage-dial-marker-swatch usage-dial-marker-swatch-alarm" />Alarm {formatPercent(alarmMarkerPercent)}</span>
      </div>
      <dl className="usage-dial-breakdown">
        <div><dt><span className="usage-dial-swatch usage-dial-swatch-manual" />Manual</dt><dd>{formatSet(manualSet)} SET</dd></div>
        <div><dt><span className="usage-dial-swatch usage-dial-swatch-autonomous" />Autonomous</dt><dd>{formatSet(autonomousSet)} SET</dd></div>
        {extraSet !== undefined && extraLabel && <div><dt><span className="usage-dial-swatch usage-dial-swatch-interactive" />{extraLabel}</dt><dd>{formatSet(extraSet)} SET</dd></div>}
      </dl>
      <p className="usage-dial-reset-note">{resetNote}</p>
      <CalibrationLabel calibration={calibration} />
    </article>
  );
}

export function UsageDial({ report, lastRefreshedAt }: { report: WeeklyUsageReport; lastRefreshedAt?: number }) {
  const now = new Date();
  return (
    <div className="insight-section usage-dial-section">
      <header className="usage-dial-section-header">
        <h3>Weekly usage</h3>
        {lastRefreshedAt !== undefined && <span className="usage-dial-last-refreshed">Last refreshed {weekdayTimeFormat.format(new Date(lastRefreshedAt))}</span>}
      </header>
      <p className="insight-section-intro">Workbench SET this week, split manual vs autonomous. Codex shows its live account percentage; Claude's bar is a pessimistic ceiling estimate until a real calibration is recorded.</p>
      <div className="usage-dial-grid">
        <ProviderDial
          label="Claude"
          manualSet={report.claude.workbench.manual.setTokens}
          autonomousSet={report.claude.workbench.autonomous.setTokens}
          extraSet={report.claude.interactive.setTokens}
          extraLabel="Interactive"
          ceilingSet={report.claude.ceilingSet}
          autonomousTargetFraction={report.autonomousTargetFraction}
          autonomousSliceFraction={report.autonomousSliceFraction}
          calibration={report.claude.calibration}
          weekEnd={report.weekEnd}
          now={now}
        />
        <ProviderDial
          label="Codex"
          manualSet={report.codex.workbench.manual.setTokens}
          autonomousSet={report.codex.workbench.autonomous.setTokens}
          ceilingSet={report.codex.ceilingSet}
          autonomousTargetFraction={report.autonomousTargetFraction}
          autonomousSliceFraction={report.autonomousSliceFraction}
          rateLimit={report.codex.rateLimit}
          calibration={report.codex.calibration}
          weekEnd={report.weekEnd}
          now={now}
        />
      </div>
    </div>
  );
}
