import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from './api';
import type { UsageCalibrationHistoryEntry, WeeklyUsageReport } from '../shared/contracts';
import { daysRemaining, percentOfCeiling } from './usage-dial-logic';

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

/** Relative-time-ish drift note: how far apart two ceilings solved, for the flagged entry's tooltip. */
function formatCeilingDelta(entry: UsageCalibrationHistoryEntry, previous: UsageCalibrationHistoryEntry | undefined): string | null {
  if (!previous || previous.computedCeilingSet === 0) return null;
  const change = ((entry.computedCeilingSet - previous.computedCeilingSet) / previous.computedCeilingSet) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(0)}% vs previous reading`;
}

/** Short history of `/usage` readings with drift flagged, so a bad transcription is visible rather than silently blended in. */
export function CalibrationHistory({ provider }: { provider: 'claude' | 'codex' }) {
  const history = useQuery({ queryKey: ['usage', 'calibration', provider], queryFn: () => api.getUsageCalibrationHistory(provider) });
  const calibrations = history.data?.calibrations ?? [];
  if (history.isLoading || calibrations.length === 0) return null;
  return (
    <div className="calibration-history">
      <h4>Calibration history</h4>
      <ul>
        {calibrations.map((entry, index) => {
          const delta = formatCeilingDelta(entry, calibrations[index + 1]);
          return (
            <li key={entry.id} className={entry.flagged ? 'calibration-history-flagged' : undefined}>
              <span>{shortDateFormat.format(new Date(entry.observedAt))}</span>
              <span>{entry.observedPercentage}%</span>
              <span>{formatSet(entry.computedCeilingSet)} SET ceiling</span>
              {entry.flagged && <span className="calibration-history-flag-note">Inconsistent{delta ? ` (${delta})` : ''}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Mobile-friendly input for a `/usage` reading — the only way Workbench's Claude ceiling gets calibrated (docs/autonomy-strategy.md "Calibration"). */
export function CalibrationForm({ provider }: { provider: 'claude' | 'codex' }) {
  const queryClient = useQueryClient();
  const [observedPercentage, setObservedPercentage] = useState('');
  const [resetsAt, setResetsAt] = useState('');
  const mutation = useMutation({
    mutationFn: (input: { observedPercentage: number; resetsAt: string | null }) =>
      api.submitUsageCalibration({ provider, observedAt: new Date().toISOString(), observedPercentage: input.observedPercentage, resetsAt: input.resetsAt }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['usage', 'weekly'] });
      queryClient.invalidateQueries({ queryKey: ['usage', 'calibration', provider] });
      setObservedPercentage('');
      setResetsAt('');
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const percentage = Number(observedPercentage);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) return;
    mutation.mutate({ observedPercentage: percentage, resetsAt: resetsAt ? new Date(resetsAt).toISOString() : null });
  }

  return (
    <form className="calibration-form" onSubmit={handleSubmit}>
      <label>
        /usage %
        <input type="number" inputMode="decimal" min="0.1" max="100" step="0.1" placeholder="e.g. 42" value={observedPercentage} onChange={(event) => setObservedPercentage(event.target.value)} required />
      </label>
      <label>
        Resets
        <input type="date" value={resetsAt} onChange={(event) => setResetsAt(event.target.value)} />
      </label>
      <button type="submit" className="button primary compact" disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Calibrate'}</button>
      {mutation.isError && <span className="error-message">Couldn't save that reading.</span>}
    </form>
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
      <CalibrationForm provider="claude" />
      <CalibrationHistory provider="claude" />
    </div>
  );
}
