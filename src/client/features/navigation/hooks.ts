import { useNavigationCounts } from './data';
import { useMobileNavigationState } from './state';

export function useNavigation() {
  return { ...useNavigationCounts(), ...useMobileNavigationState() };
}
