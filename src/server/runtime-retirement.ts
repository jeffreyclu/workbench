let retire: (() => void) | null = null;

/** The blue/green supervisor asks a retired backend to stop accepting new
 * background work while it keeps already-running external agent streams alive. */
export function configureRuntimeRetirement(handler: () => void): void {
  retire = handler;
}

export function beginRuntimeRetirement(): void {
  retire?.();
}
