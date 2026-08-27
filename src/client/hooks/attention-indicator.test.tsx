// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAttentionIndicator } from './attention-indicator';

function Indicator({ count }: { count: number }) {
  useAttentionIndicator(count);
  return null;
}

afterEach(() => {
  document.title = 'Workbench';
  document.head.querySelector('link[rel="icon"]')?.remove();
});

describe('attention indicator', () => {
  it('updates the title and favicon for actionable conversations, then clears both', () => {
    const favicon = document.createElement('link');
    favicon.rel = 'icon';
    favicon.href = 'data:image/svg+xml,original';
    document.head.append(favicon);

    const { rerender } = render(<Indicator count={2} />);

    expect(document.title).toBe('(2) Workbench');
    expect(favicon.href).toContain('circle');

    rerender(<Indicator count={0} />);

    expect(document.title).toBe('Workbench');
    expect(favicon.href).not.toContain('circle');
  });

  it('restores the pre-existing browser chrome when Workbench unmounts', () => {
    document.title = 'Original title';
    const favicon = document.createElement('link');
    favicon.rel = 'icon';
    favicon.href = 'data:image/svg+xml,original';
    document.head.append(favicon);

    const { unmount } = render(<Indicator count={1} />);
    unmount();

    expect(document.title).toBe('Original title');
    expect(favicon.href).toContain('original');
  });

});
