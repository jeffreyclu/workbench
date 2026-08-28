import type { BrokerConnection } from '../../../shared/contracts';

export type SourceAuthorizationState =
  | { status: 'idle' }
  | { status: 'awaiting-auth'; authorizationUrl: string }
  | { status: 'check-auth'; authorizationUrl: string }
  | { status: 'authorized'; authorizationUrl: string }
  | { status: 'failed'; authorizationUrl: string; error: string };

export type SourceAuthorizationEvent =
  | { type: 'authorization-started'; authorizationUrl: string }
  | { type: 'check-started' }
  | { type: 'check-finished'; authorized: boolean }
  | { type: 'check-failed'; error: string }
  | { type: 'reset' };

export const initialSourceAuthorizationState: SourceAuthorizationState = { status: 'idle' };

export function reduceSourceAuthorization(
  state: SourceAuthorizationState,
  event: SourceAuthorizationEvent,
): SourceAuthorizationState {
  if (event.type === 'reset') return initialSourceAuthorizationState;
  if (event.type === 'authorization-started') {
    return { status: 'awaiting-auth', authorizationUrl: event.authorizationUrl };
  }
  if (state.status === 'idle' || state.status === 'authorized') return state;
  if (event.type === 'check-started') {
    return { status: 'check-auth', authorizationUrl: state.authorizationUrl };
  }
  if (event.type === 'check-finished') {
    return event.authorized
      ? { status: 'authorized', authorizationUrl: state.authorizationUrl }
      : { status: 'awaiting-auth', authorizationUrl: state.authorizationUrl };
  }
  if (event.type === 'check-failed') {
    return { status: 'failed', authorizationUrl: state.authorizationUrl, error: event.error };
  }
  return state;
}

export function sourceDisconnectProvider(provider: BrokerConnection['id']) {
  return provider === 'atlassian' ? 'confluence' : provider === 'slack' || provider === 'figma' || provider === 'grafana' ? provider : 'github';
}

export function canAuthorizeSource(provider: BrokerConnection['id']) {
  return provider === 'atlassian' || provider === 'slack' || provider === 'figma' || provider === 'grafana';
}

export function usesManagedAuthorization(provider: BrokerConnection['id']) {
  return provider === 'atlassian' || provider === 'figma';
}
