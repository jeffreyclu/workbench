import { useLayoutEffect, useRef } from 'react';

type TextContext = CanvasRenderingContext2D & { letterSpacing?: string };

/**
 * Keeps real text in flow for the badge's native width and accessible name,
 * then draws the same glyph from its measured ink bounds. CSS can center a
 * line box; TextMetrics lets us center the visible glyph itself on both axes.
 */
export function OpticallyCenteredNumber({ value }: { value: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sizerRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const sizer = sizerRef.current;
    const badge = canvas?.parentElement;
    if (!canvas || !sizer || !badge) return undefined;

    const draw = () => {
      const width = badge.clientWidth;
      const height = badge.clientHeight;
      if (width <= 0 || height <= 0) return;

      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const context = canvas.getContext('2d') as TextContext | null;
      if (!context) return;
      const style = getComputedStyle(sizer);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);
      context.font = [style.fontStyle, style.fontVariant, style.fontWeight, style.fontStretch, `${style.fontSize} ${style.fontFamily}`]
        .filter((part) => part && part !== 'normal')
        .join(' ');
      context.fillStyle = style.getPropertyValue('--stack-count-ink') || style.color;
      if ('letterSpacing' in context) context.letterSpacing = style.letterSpacing;
      context.textAlign = 'left';
      context.textBaseline = 'alphabetic';

      const text = String(value);
      const metrics = context.measureText(text);
      const x = width / 2 + (metrics.actualBoundingBoxLeft - metrics.actualBoundingBoxRight) / 2;
      const y = height / 2 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
      context.fillText(text, x, y);
    };

    draw();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
    observer?.observe(badge);
    const fonts = document.fonts;
    void fonts?.ready.then(draw);
    fonts?.addEventListener('loadingdone', draw);
    return () => {
      observer?.disconnect();
      fonts?.removeEventListener('loadingdone', draw);
    };
  }, [value]);

  return <>
    <span ref={sizerRef} className="optically-centered-number-sizer">{value}</span>
    <canvas ref={canvasRef} className="optically-centered-number-canvas" aria-hidden="true" />
  </>;
}
