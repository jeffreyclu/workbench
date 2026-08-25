const COLORS = ['#c6f432', '#ffe98a', '#f0cf5a', '#7dd3fc', '#fb923c', '#f472b6'];

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Fires a brief confetti burst from the given viewport point (defaults to screen center). */
export function celebrate(origin?: { x: number; y: number }): void {
  if (prefersReducedMotion()) return;
  const { x, y } = origin ?? { x: window.innerWidth / 2, y: window.innerHeight / 3 };
  const container = document.createElement('div');
  container.className = 'celebration-burst';
  const pieceCount = 60;
  for (let index = 0; index < pieceCount; index += 1) {
    const piece = document.createElement('span');
    piece.className = 'celebration-piece';
    const angle = Math.random() * Math.PI * 2;
    const distance = 120 + Math.random() * 220;
    piece.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    piece.style.setProperty('--dy', `${Math.sin(angle) * distance - 60}px`);
    piece.style.setProperty('--rotate', `${Math.random() * 720 - 360}deg`);
    piece.style.setProperty('--delay', `${Math.random() * 90}ms`);
    piece.style.setProperty('--duration', `${900 + Math.random() * 500}ms`);
    piece.style.background = COLORS[index % COLORS.length];
    piece.style.left = `${x}px`;
    piece.style.top = `${y}px`;
    container.appendChild(piece);
  }
  document.body.appendChild(container);
  window.setTimeout(() => container.remove(), 1600);
}
