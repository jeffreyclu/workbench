import { useCallback, useState } from 'react';
import { readDesktopNotificationsEnabled, writeDesktopNotificationsEnabled } from '../lib/preferences';

export type DesktopNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export function isDesktopNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function currentPermission(): DesktopNotificationPermission {
  return isDesktopNotificationSupported() ? Notification.permission : 'unsupported';
}

export interface DesktopNotificationOptions {
  title: string;
  body?: string;
  onClick?: () => void;
}

/** Fires an OS notification when Jeffrey's preference and the browser's
 * permission grant allow it. Toasts call this unconditionally, including while
 * Workbench is focused, so every visible toast has a matching OS notification. */
export function sendDesktopNotification({ title, body, onClick }: DesktopNotificationOptions): void {
  if (!isDesktopNotificationSupported()) return;
  if (!readDesktopNotificationsEnabled()) return;
  if (Notification.permission !== 'granted') return;
  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href;
  const notification = new Notification(title, { body, icon: favicon, tag: 'workbench' });
  if (onClick) {
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  }
}

/** Drives the notification-preferences toggle: reads/writes Jeffrey's opt-in
 * and requests the browser permission grant, which can only happen from a
 * user gesture (a click on the toggle), never automatically. */
export function useDesktopNotificationPreference(): {
  supported: boolean;
  enabled: boolean;
  permission: DesktopNotificationPermission;
  setEnabled: (enabled: boolean) => Promise<void>;
} {
  const supported = isDesktopNotificationSupported();
  const [enabled, setEnabledState] = useState(() => supported && readDesktopNotificationsEnabled());
  const [permission, setPermission] = useState<DesktopNotificationPermission>(currentPermission);

  const setEnabled = useCallback(async (next: boolean) => {
    if (!supported) return;
    if (next && Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        writeDesktopNotificationsEnabled(false);
        setEnabledState(false);
        return;
      }
    } else {
      setPermission(currentPermission());
    }
    writeDesktopNotificationsEnabled(next);
    setEnabledState(next);
  }, [supported]);

  return { supported, enabled, permission, setEnabled };
}
