import { memo, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, MessageSquare, X } from 'lucide-react';
import { DECISION_STATE_LABEL, FILE_STATUS_LETTER, describeFileRow, type FileNavigatorRow } from './file-navigator-logic.js';

const PHONE_QUERY = '(max-width: 720px)';
const isPhone = () => Boolean(window.matchMedia?.(PHONE_QUERY).matches);

/**
 * Every changed file in one compact list: status, size, how far its decisions
 * have been answered, open notes and a whitespace-only marker. The decision
 * queue orders the work to be judged; this orders the files, so a reviewer can
 * open any file directly, the way a source-control sidebar does.
 *
 * It is a collapsible pane on a wide screen and a bottom sheet on a phone,
 * where it starts closed and rows are 44px tall. Arrow keys, Home and End move
 * between rows (one tab stop); Enter or Space opens the focused file.
 */
export const DiffFileNavigator = memo(function DiffFileNavigator({ rows, selectedPath, onSelect }: {
  rows: FileNavigatorRow[];
  selectedPath: string | null;
  onSelect: (row: FileNavigatorRow) => void;
}) {
  const [open, setOpen] = useState(() => !isPhone());
  const bodyId = useId();
  const toggle = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const reviewed = rows.filter((row) => row.decisionState === 'reviewed').length;
  // Exactly one row is in the tab order: the open file, or the first row.
  const tabStop = rows.some((row) => row.path === selectedPath) ? selectedPath : rows[0]?.path ?? null;

  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button.file-navigator-row') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
    if (next === null || at === -1 || buttons.length === 0) return;
    event.preventDefault();
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };

  return <section className={`file-navigator${open ? ' is-open' : ''}`} aria-label="Changed files">
    <button ref={toggle} type="button" className="file-navigator-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((current) => !current)}>
      {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
      <span>Files</span>
      <small>{reviewed} of {rows.length} files reviewed</small>
    </button>
    {open && <div id={bodyId} className="file-navigator-body" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <header className="file-navigator-sheet-header">
        <strong>Changed files</strong>
        <button type="button" aria-label="Close changed files" onClick={close}><X size={15} aria-hidden="true" /></button>
      </header>
      <ul ref={list} onKeyDown={onListKeyDown}>
        {rows.map((row) => {
          const selected = row.path === selectedPath;
          return <li key={row.path}>
            <button
              type="button"
              className={`file-navigator-row state-${row.decisionState}${selected ? ' selected' : ''}`}
              tabIndex={row.path === tabStop ? 0 : -1}
              aria-current={selected ? 'true' : undefined}
              aria-disabled={row.decisionId ? undefined : 'true'}
              aria-label={describeFileRow(row)}
              title={row.decisionId ? row.label : `${row.label} has no decision to open`}
              onClick={() => {
                if (!row.decisionId) return;
                onSelect(row);
                if (isPhone()) setOpen(false);
              }}
            >
              <span className={`file-navigator-status status-${row.status}`} aria-hidden="true">{FILE_STATUS_LETTER[row.status]}</span>
              <span className="file-navigator-path" aria-hidden="true">{row.label}</span>
              <span className="file-navigator-counts" aria-hidden="true"><b className="added">+{row.additions}</b> <b className="removed">−{row.deletions}</b></span>
              <span className="file-navigator-state" aria-hidden="true">{row.decisionsTotal > 0 ? `${DECISION_STATE_LABEL[row.decisionState]} ${row.decisionsSettled}/${row.decisionsTotal}` : DECISION_STATE_LABEL.none}</span>
              {row.risk && <span className={`file-navigator-risk risk-${row.risk}`} aria-hidden="true">{row.risk}</span>}
              {row.openNotes > 0 && <span className="file-navigator-notes" aria-hidden="true"><MessageSquare size={10} />{row.openNotes}</span>}
              {row.whitespaceOnly && <span className="file-navigator-whitespace" aria-hidden="true">whitespace only</span>}
            </button>
          </li>;
        })}
      </ul>
    </div>}
  </section>;
});
