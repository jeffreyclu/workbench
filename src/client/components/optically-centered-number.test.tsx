// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpticallyCenteredNumber } from './optically-centered-number';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OpticallyCenteredNumber', () => {
  it('centers the measured glyph bounds horizontally and vertically', () => {
    const fillText = vi.fn();
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), fillText,
      measureText: vi.fn(() => ({
        actualBoundingBoxLeft: 1, actualBoundingBoxRight: 11,
        actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 3,
      })),
      font: '', fillStyle: '', letterSpacing: '', textAlign: 'start', textBaseline: 'alphabetic',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(24);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(20);

    const { container } = render(<strong><OpticallyCenteredNumber value={25} /></strong>);

    expect(container.querySelector('.optically-centered-number-sizer')).toHaveTextContent('25');
    expect(context.measureText).toHaveBeenCalledWith('25');
    // Drawn ink becomes x=6..18 and y=5..15: centered exactly at 12,10.
    expect(fillText).toHaveBeenCalledWith('25', 7, 12);
  });
});
