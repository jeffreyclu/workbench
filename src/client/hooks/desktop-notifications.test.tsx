// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDesktopNotificationSupported, sendDesktopNotification, useDesktopNotificationPreference } from './desktop-notifications';
import { readDesktopNotificationsEnabled, writeDesktopNotificationsEnabled } from '../lib/preferences';

class MockNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async () => MockNotification.permission);
  static instances: MockNotification[] = [];
  title: string;
  options?: NotificationOptions;
  onclick: (() => void) | null = null;
  close = vi.fn();

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    MockNotification.instances.push(this);
  }
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

function setFocused(focused: boolean) {
  document.hasFocus = () => focused;
}

beforeEach(() => {
  MockNotification.permission = 'default';
  MockNotification.instances = [];
  vi.stubGlobal('Notification', MockNotification);
  window.focus = vi.fn();
  setHidden(true);
  setFocused(false);
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});

describe('sendDesktopNotification', () => {
  it('does nothing when the browser has not granted permission', () => {
    MockNotification.permission = 'denied';
    sendDesktopNotification({ title: 'Run finished' });
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('does nothing when Jeffrey has disabled the preference', () => {
    MockNotification.permission = 'granted';
    writeDesktopNotificationsEnabled(false);
    sendDesktopNotification({ title: 'Run finished' });
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('fires while Workbench is the focused, visible tab', () => {
    MockNotification.permission = 'granted';
    setHidden(false);
    setFocused(true);
    sendDesktopNotification({ title: 'Run finished' });
    expect(MockNotification.instances).toHaveLength(1);
  });

  it('fires when granted and enabled, and routes clicks', () => {
    MockNotification.permission = 'granted';
    const onClick = vi.fn();
    sendDesktopNotification({ title: 'Run finished', body: 'Task X completed', onClick });
    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0].title).toBe('Run finished');
    expect(MockNotification.instances[0].options?.body).toBe('Task X completed');

    MockNotification.instances[0].onclick?.();
    expect(onClick).toHaveBeenCalled();
  });
});

describe('useDesktopNotificationPreference', () => {
  function Preference({ onReady }: { onReady: (value: ReturnType<typeof useDesktopNotificationPreference>) => void }) {
    const value = useDesktopNotificationPreference();
    onReady(value);
    return null;
  }

  it('requests browser permission on first enable and persists the grant', async () => {
    MockNotification.permission = 'default';
    MockNotification.requestPermission = vi.fn(async () => 'granted');
    let latest: ReturnType<typeof useDesktopNotificationPreference> | null = null;
    render(<Preference onReady={(value) => { latest = value; }} />);

    await act(async () => { await latest!.setEnabled(true); });

    expect(MockNotification.requestPermission).toHaveBeenCalled();
    expect(readDesktopNotificationsEnabled()).toBe(true);
  });

  it('turns the preference back off when the browser denies permission', async () => {
    MockNotification.permission = 'default';
    MockNotification.requestPermission = vi.fn(async () => 'denied');
    let latest: ReturnType<typeof useDesktopNotificationPreference> | null = null;
    render(<Preference onReady={(value) => { latest = value; }} />);

    await act(async () => { await latest!.setEnabled(true); });

    expect(readDesktopNotificationsEnabled()).toBe(false);
    expect(latest!.enabled).toBe(false);
  });
});

describe('isDesktopNotificationSupported', () => {
  it('reflects whether the browser exposes the Notification API', () => {
    expect(isDesktopNotificationSupported()).toBe(true);
    vi.unstubAllGlobals();
    // @ts-expect-error -- simulating a browser without desktop notification support
    delete window.Notification;
    expect(isDesktopNotificationSupported()).toBe(false);
  });
});
