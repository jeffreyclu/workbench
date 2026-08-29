import { describe, expect, it } from 'vitest';
import { auditParityTable, parityAuditIsClean, parityAuditNote, parityTableApplies } from './parity-table.js';

const complete = [
  'SIGNATURE: SAME — same parameters and return type.',
  'ERROR HANDLING: CHANGED — the catch now rethrows [src/sync.ts:42].',
  'ORDERING: SAME — the loop still runs before the flush.',
  'COMPLEXITY: SAME — one fewer local, no new branch.',
].join('\n');

describe('parityTableApplies', () => {
  it('demands a parity table only from the types that claim equivalence', () => {
    expect(parityTableApplies('refactor_pure')).toBe(true);
    expect(parityTableApplies('replacement')).toBe(true);
  });

  it('exempts a behavior edit, which is expected to differ rather than to match', () => {
    expect(parityTableApplies('behavior_edit')).toBe(false);
    expect(parityTableApplies('new_code')).toBe(false);
    expect(parityTableApplies('test_only')).toBe(false);
  });
});

describe('auditParityTable', () => {
  it('passes a table that answers every axis', () => {
    expect(parityAuditIsClean(auditParityTable(complete))).toBe(true);
    expect(parityAuditNote(auditParityTable(complete))).toBeNull();
  });

  it('names the axis a free-form comparison quietly skipped', () => {
    const audit = auditParityTable('SIGNATURE: SAME — identical.\nERROR HANDLING: SAME — identical.');
    expect(audit.missingAxes).toEqual(['ORDERING', 'COMPLEXITY']);
    expect(parityAuditNote(audit)).toContain('ordering, complexity not compared');
    expect(parityAuditNote(audit)).toContain('not as equivalent');
  });

  it('reads the verdict from the slot after the label, so prose about what changed is not mistaken for a verdict', () => {
    const audit = auditParityTable([
      'SIGNATURE: SAME — nothing changed about the parameters.',
      'ERROR HANDLING: SAME — unchanged.',
      'ORDERING: SAME — unchanged.',
      'COMPLEXITY: SAME — unchanged.',
    ].join('\n'));
    expect(parityAuditIsClean(audit)).toBe(true);
  });

  it('flags an axis stated without one of the closed verdicts, which reads as a verdict but cannot be compared', () => {
    const audit = auditParityTable(complete.replace('ORDERING: SAME — the loop still runs before the flush.', 'ORDERING: looks fine to me.'));
    expect(audit.unverdictedAxes).toEqual(['ORDERING']);
    expect(parityAuditNote(audit)).toContain('without a SAME/CHANGED/UNCLEAR verdict');
  });

  it('flags a difference reported with no citation, since an uncited difference is one the reviewer has to hunt for', () => {
    const audit = auditParityTable(complete.replace(' [src/sync.ts:42]', ''));
    expect(audit.uncitedChanges).toEqual(['ERROR HANDLING']);
    expect(parityAuditNote(audit)).toContain('reported as changed with no citation');
  });

  it('accepts a bulleted, lower-case, hyphenated table, because only whether the axis was compared matters', () => {
    const audit = auditParityTable([
      '- signature: same — identical.',
      '* Error-Handling: unclear — the catch body is not shown.',
      '• ordering: same — identical.',
      'complexity: same — identical.',
    ].join('\n'));
    expect(parityAuditIsClean(audit)).toBe(true);
  });
});
