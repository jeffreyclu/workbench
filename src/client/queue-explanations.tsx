import type { QueueItemExplanation } from '../shared/contracts';

/** Per-task score breakdown backing a queue proposal or the "why this order" explain view. */
export function QueueExplanationList({ explanations }: { explanations: QueueItemExplanation[] }) {
  if (!explanations.length) return <p className="explanation-empty">No score breakdown is available yet.</p>;
  return <ol className="queue-explanations">
    {explanations.map((explanation) => {
      const moved = explanation.proposedPosition - explanation.previousPosition;
      return <li key={explanation.itemId} className="queue-explanation">
        <div className="queue-explanation-head">
          <span className="queue-explanation-rank">{String(explanation.proposedPosition + 1).padStart(2, '0')}</span>
          <strong>{explanation.title}</strong>
          {moved !== 0 && <span className={`queue-explanation-move ${moved < 0 ? 'up' : 'down'}`}>{moved < 0 ? `↑ ${Math.abs(moved)}` : `↓ ${moved}`}</span>}
        </div>
        {explanation.signals.length > 0 && <ul className="queue-signal-list">
          {explanation.signals.map((signal, index) => <li key={`${explanation.itemId}-${signal.key}-${index}`} className={signal.delta >= 0 ? 'positive' : 'negative'}>
            <span className="queue-signal-delta">{signal.delta >= 0 ? '+' : ''}{signal.delta}</span> {signal.detail}
          </li>)}
        </ul>}
      </li>;
    })}
  </ol>;
}
