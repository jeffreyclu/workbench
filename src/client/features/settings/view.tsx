import { Bell, BellOff, X } from 'lucide-react';
import { ModalDialog } from '../../components/dialogs/modal-dialog';
import { useDesktopNotificationPreference } from '../../hooks/desktop-notifications';

function DesktopNotificationSetting() {
  const { supported, enabled, permission, setEnabled } = useDesktopNotificationPreference();
  if (!supported) return <div className="connection-card unavailable">
    <div className="connection-summary"><span><strong>Desktop notifications</strong><small>Not supported in this browser.</small></span></div>
  </div>;
  const blocked = permission === 'denied';
  const status = blocked ? 'Blocked in browser settings' : enabled ? 'Enabled' : 'Disabled';
  return (
    <div className={`connection-card ${enabled && !blocked ? 'connected' : ''}`}>
      <div className="connection-summary">
        <span><strong>Desktop notifications</strong><small>{blocked ? 'Allow notifications for Workbench in your browser to enable this.' : 'Get an OS notification for every Workbench toast.'}</small></span>
        <button
          type="button"
          className="button secondary compact"
          disabled={blocked}
          aria-pressed={enabled && !blocked}
          onClick={() => void setEnabled(!enabled)}
        >
          {enabled && !blocked ? <Bell size={13} /> : <BellOff size={13} />} {status}
        </button>
      </div>
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <ModalDialog className="sources-dialog" labelledBy="settings-dialog-title" onClose={onClose}>
      <div className="dialog-header">
        <div><span className="eyebrow">Workbench</span><h2 id="settings-dialog-title">Settings</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button>
      </div>
      <p className="dialog-description">Preferences for how Workbench behaves on this device.</p>
      <div className="connection-list">
        <DesktopNotificationSetting />
      </div>
    </ModalDialog>
  );
}
