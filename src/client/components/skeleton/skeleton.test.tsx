// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationComposerSkeleton, ConversationRailSkeleton, ConversationSearchResultSkeleton, ConversationThreadSkeleton } from './skeleton';

afterEach(cleanup);

describe('conversation loading skeletons', () => {
  it('uses the same card, thread, and composer layout classes as the loaded conversation UI', () => {
    const { container } = render(<><ConversationRailSkeleton count={2} /><ConversationThreadSkeleton /><ConversationComposerSkeleton /><ConversationSearchResultSkeleton /></>);

    expect(container.querySelectorAll('.conversation-skeleton-card')).toHaveLength(2);
    expect(container.querySelectorAll('.conversation-skeleton-message.shared-message')).toHaveLength(4);
    expect(container.querySelector('.conversation-skeleton-message.shared-jeffrey')).toBeInTheDocument();
    expect(container.querySelector('.conversation-composer-skeleton.shared-composer')).toBeInTheDocument();
    expect(container.querySelector('.conversation-composer-skeleton-toolbar.composer-toolbar')).toBeInTheDocument();
    expect(container.querySelectorAll('.conversation-search-skeleton-row')).toHaveLength(3);
  });
});
