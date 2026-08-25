import { Minus, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useState } from 'react';
import type { SessionFeedbackRating } from '../shared/contracts';
import { ModalDialog } from './modal-dialog';

const choices: Array<{ rating: SessionFeedbackRating; label: string; Icon: typeof ThumbsUp }> = [
  { rating: 'positive', label: 'Good', Icon: ThumbsUp },
  { rating: 'neutral', label: 'Okay', Icon: Minus },
  { rating: 'negative', label: 'Poor', Icon: ThumbsDown },
];

/** Required, compact session verdict. It intentionally has no dismissal path. */
export function SessionFeedbackPrompt({ onSubmit }: { onSubmit: (rating: SessionFeedbackRating) => Promise<void> }) {
  const [pending, setPending] = useState<SessionFeedbackRating | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function submit(rating: SessionFeedbackRating) {
    setPending(rating); setError(null);
    try { await onSubmit(rating); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save your feedback. Try again.'); setPending(null); }
  }
  return <ModalDialog className="session-feedback-prompt" labelledBy="session-feedback-title" describedBy="session-feedback-description" onClose={() => {}} closeDisabled>
    <span className="eyebrow">Session feedback</span>
    <h2 id="session-feedback-title">How did we do?</h2>
    <p id="session-feedback-description">Choose one rating to save this session’s decision tree with your result.</p>
    <div className="session-feedback-choices" role="group" aria-label="How did we do?">
      {choices.map(({ rating, label, Icon }) => <button key={rating} type="button" className={`session-feedback-choice ${rating}`} disabled={pending !== null} onClick={() => void submit(rating)}><Icon size={20} aria-hidden="true" /><span>{pending === rating ? 'Saving…' : label}</span></button>)}
    </div>
    {error && <p className="session-feedback-error" role="alert">{error}</p>}
  </ModalDialog>;
}
