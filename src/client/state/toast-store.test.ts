// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendDesktopNotification } = vi.hoisted(() => ({ sendDesktopNotification: vi.fn() }));

vi.mock('../hooks/desktop-notifications', () => ({ sendDesktopNotification }));

import { toast } from './toast-store';

beforeEach(() => {
  toast.clear();
  sendDesktopNotification.mockClear();
});

describe('desktop delivery', () => {
  it('sends one desktop notification for every toast call, including duplicates', () => {
    const action = vi.fn();

    toast.success('Saved', { description: 'Task A' });
    toast.error('Failed');
    toast.info('Open task', { action, actionLabel: 'Open' });
    toast.success('Saved', { description: 'Task A' });

    expect(sendDesktopNotification.mock.calls).toEqual([
      [{ title: 'Success', body: 'Saved — Task A', onClick: undefined }],
      [{ title: 'Error', body: 'Failed', onClick: undefined }],
      [{ title: 'Workbench', body: 'Open task', onClick: action }],
      [{ title: 'Success', body: 'Saved — Task A', onClick: undefined }],
    ]);
  });
});
