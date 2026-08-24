import type { BrokerConnection } from '../../../shared/contracts';

export function sourceDisconnectProvider(provider: BrokerConnection['id']) {
  return provider === 'atlassian' ? 'confluence' : provider === 'slack' || provider === 'figma' ? provider : 'github';
}

export function canAuthorizeSource(provider: BrokerConnection['id']) {
  return provider === 'atlassian' || provider === 'slack' || provider === 'figma';
}
