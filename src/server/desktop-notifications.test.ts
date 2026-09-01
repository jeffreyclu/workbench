import { describe, expect, it, vi } from 'vitest';
import { sendMacDesktopNotification } from './desktop-notifications.js';

describe('sendMacDesktopNotification', () => {
  it('passes notification text as argv instead of interpolating it into AppleScript', () => {
    const execute = vi.fn();

    sendMacDesktopNotification('Success "quoted"', 'Saved — it\'s done', execute);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      [
        '-e',
        expect.stringContaining('display notification (item 2 of argv) with title (item 1 of argv)'),
        'Success "quoted"',
        'Saved — it\'s done',
      ],
      { stdio: 'ignore', timeout: 5_000 },
    );
  });
});
