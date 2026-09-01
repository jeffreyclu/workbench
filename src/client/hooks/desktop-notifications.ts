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

function showBrowserNotification({ title, body, onClick }: DesktopNotificationOptions): void {
  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href;
  const notification = new Notification(title, { body, icon: favicon });
  if (onClick) {
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  }
}

/** Fires an OS notification when Jeffrey's preference and the browser's
 * permission grant allow it. The live local runtime uses macOS directly so an
 * active browser tab cannot suppress the alert; the browser API remains the
 * fallback for previews and non-local runtimes. */
export function sendDesktopNotification({ title, body, onClick }: DesktopNotificationOptions): void {
  if (!isDesktopNotificationSupported()) return;
  if (!readDesktopNotificationsEnabled()) return;
  if (Notification.permission !== 'granted') return;
  const fallback = () => showBrowserNotification({ title, body, onClick });
  try {
    void fetch('/api/desktop-notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, body: body ?? '' }),
    }).then((response) => { if (!response.ok) fallback(); }, fallback);
  } catch {
    fallback();
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
