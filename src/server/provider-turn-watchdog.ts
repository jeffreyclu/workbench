export type ProviderTurnTimeoutReason = 'first_activity' | 'idle_activity';
export type ProviderTurnPhase = 'idle' | 'awaiting_activity' | 'active' | 'terminal';

export interface ProviderTurnWatchdogOptions {
  firstActivityMs: number;
  idleActivityMs: number;
  onTimeout: (reason: ProviderTurnTimeoutReason) => void;
}

/**
 * Provider-neutral watchdog for a reusable transport process.
 *
 * A process is not a turn. Claude can accept several user messages on one
 * stream-json process and Codex can accept several steers on one app-server
 * turn. Every accepted input therefore opens a fresh watchdog generation.
 * Activity and timeout callbacks are scoped to that generation, while
 * `completed` makes an otherwise reusable process quiescent without pretending
 * the process itself terminated.
 */
export class ProviderTurnWatchdog {
  private phaseValue: ProviderTurnPhase = 'idle';
  private generationValue = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ProviderTurnWatchdogOptions) {}

  get phase(): ProviderTurnPhase { return this.phaseValue; }
  get generation(): number { return this.generationValue; }

  /** A provider accepted a new initial input or live interjection. */
  accepted(): number {
    if (this.phaseValue === 'terminal') return this.generationValue;
    this.generationValue += 1;
    this.phaseValue = 'awaiting_activity';
    this.arm('first_activity', this.options.firstActivityMs, this.generationValue);
    return this.generationValue;
  }

  /** Human-visible model or tool activity arrived for the current generation. */
  activity(): void {
    if (this.phaseValue === 'terminal' || this.phaseValue === 'idle') return;
    this.phaseValue = 'active';
    this.arm('idle_activity', this.options.idleActivityMs, this.generationValue);
  }

  /** The provider emitted a terminal result for all inputs accepted so far. */
  completed(): void {
    if (this.phaseValue === 'terminal') return;
    this.phaseValue = 'idle';
    this.clear();
  }

  /** The transport process closed or is being forcibly stopped. */
  terminal(): void {
    this.phaseValue = 'terminal';
    this.clear();
  }

  private arm(reason: ProviderTurnTimeoutReason, delayMs: number, generation: number): void {
    this.clear();
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.phaseValue === 'terminal' || this.phaseValue === 'idle' || generation !== this.generationValue) return;
      this.options.onTimeout(reason);
    }, delayMs);
    this.timer.unref();
  }

  private clear(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

function configuredTimeout(name: string, fallback: number): number {
  const configured = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

export function providerTurnTimeouts(): { firstActivityMs: number; idleActivityMs: number } {
  return {
    firstActivityMs: configuredTimeout('WORKBENCH_PROVIDER_FIRST_ACTIVITY_TIMEOUT_MS', 60_000),
    idleActivityMs: configuredTimeout('WORKBENCH_PROVIDER_IDLE_ACTIVITY_TIMEOUT_MS', 3 * 60_000),
  };
}

export function claudeResponseSettleMs(): number {
  return configuredTimeout('WORKBENCH_CLAUDE_RESPONSE_SETTLE_MS', 15_000);
}
