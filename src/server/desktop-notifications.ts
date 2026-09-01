import { execFileSync } from 'node:child_process';

const notificationScript = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run`;

type NotificationExecutor = typeof execFileSync;

/** Uses the same native macOS notification path that was verified manually. */
export function sendMacDesktopNotification(title: string, body: string, execute: NotificationExecutor = execFileSync): void {
  execute('/usr/bin/osascript', ['-e', notificationScript, title, body], { stdio: 'ignore', timeout: 5_000 });
}
