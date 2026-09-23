// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAttentionIndicator } from './attention-indicator';

const { sendDesktopNotification } = vi.hoisted(() => ({ sendDesktopNotification: vi.fn() }));

vi.mock('./desktop-notifications', () => ({ sendDesktopNotification }));

function Indicator({ count }: { count: number }) {
  useAttentionIndicator(count);
  return null;
}

afterEach(() => {
  document.title = 'Workbench';
  document.head.querySelector('link[rel="icon"]')?.remove();
  sendDesktopNotification.mockReset();
  vi.restoreAllMocks();
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

  it('alerts about newly actionable work while Workbench is backgrounded', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { rerender } = render(<Indicator count={0} />);

    rerender(<Indicator count={1} />);

    expect(sendDesktopNotification).toHaveBeenCalledWith({
      title: 'Workbench needs attention',
      body: '1 agent run is ready for you.',
    });
  });

  it('does not alert for existing work or while Workbench is frontmost', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { rerender } = render(<Indicator count={1} />);

    rerender(<Indicator count={2} />);

    expect(sendDesktopNotification).not.toHaveBeenCalled();
  });

});
