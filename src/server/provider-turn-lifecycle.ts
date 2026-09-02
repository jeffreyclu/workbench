export type ProviderTurnTimeoutReason = 'first_activity' | 'idle_activity';
export type ProviderTurnPhase = 'starting' | 'waiting_for_activity' | 'active' | 'terminal';

export interface ProviderTurnLifecycleOptions {
  firstActivityMs: number;
  idleActivityMs: number;
  onTimeout: (reason: ProviderTurnTimeoutReason) => void;
}

/**
 * One provider-neutral lifecycle for Claude and Codex turns. Transport startup
 * is not model startup: the turn becomes active only after human-visible model
 * or tool activity. Once active, the same watchdog prevents a lost subprocess
 * or wedged provider stream from retaining a durable lease forever.
 */
export class ProviderTurnLifecycle {
  private phaseValue: ProviderTurnPhase = 'starting';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ProviderTurnLifecycleOptions) {}

  get phase(): ProviderTurnPhase { return this.phaseValue; }

  accepted(): void {
    if (this.phaseValue === 'terminal' || this.phaseValue === 'active') return;
    this.phaseValue = 'waiting_for_activity';
    this.arm('first_activity', this.options.firstActivityMs);
  }

  activity(): void {
    if (this.phaseValue === 'terminal') return;
    this.phaseValue = 'active';
    this.arm('idle_activity', this.options.idleActivityMs);
  }

  terminal(): void {
    this.phaseValue = 'terminal';
    this.clear();
  }

  private arm(reason: ProviderTurnTimeoutReason, delayMs: number): void {
    this.clear();
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.phaseValue === 'terminal') return;
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
    idleActivityMs: configuredTimeout('WORKBENCH_PROVIDER_IDLE_ACTIVITY_TIMEOUT_MS', 10 * 60_000),
  };
}
