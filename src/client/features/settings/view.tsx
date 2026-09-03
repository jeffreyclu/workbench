import { Bell, BellOff, CircleHelp, X } from 'lucide-react';
import { ModalDialog } from '../../components/dialogs/modal-dialog';
import { useDesktopNotificationPreference } from '../../hooks/desktop-notifications';
import { AiProviderSelect } from '../../components/ai-provider-select';
import { useAiProvider } from '../../hooks/ai-provider';

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

/** The same choice the create-task dialog and the review pane make, in the one
 * place Jeffrey can see it without opening a surface that spends a turn. A
 * conversation overrides it from its own composer. */
function AiProviderSetting() {
  const { provider, setProvider } = useAiProvider();
  return (
    <div className="connection-card">
      <div className="connection-summary">
        <span><strong>AI provider</strong><small>Which model answers task drafts, diff risk scores, and review assist. Auto prefers Palmyra wherever it is reachable.</small></span>
        <AiProviderSelect value={provider} onChange={setProvider} ariaLabel="Default AI provider" />
      </div>
    </div>
  );
}

export function KeyboardHelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <ModalDialog className="keyboard-help-dialog" labelledBy="keyboard-help-title" describedBy="keyboard-help-description" onClose={onClose}>
      <header className="keyboard-help-header">
        <div><span className="eyebrow">Help</span><h2 id="keyboard-help-title">Keyboard shortcuts</h2></div>
        <button type="button" className="icon-button" aria-label="Close keyboard shortcuts" onClick={onClose}><X size={15} /></button>
      </header>
      <p id="keyboard-help-description">Use these shortcuts when focus is not in a text field. Press Escape to close this help.</p>
      <div className="keyboard-help-groups">
        <section aria-labelledby="keyboard-help-global"><h3 id="keyboard-help-global">Global</h3><dl><div><dt><kbd>⌘ K</kbd> / <kbd>Ctrl K</kbd></dt><dd>Search everything</dd></div><div><dt><kbd>?</kbd></dt><dd>Open keyboard shortcuts</dd></div></dl></section>
        <section aria-labelledby="keyboard-help-queue"><h3 id="keyboard-help-queue">Task queue</h3><dl><div><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Move between queue items</dd></div><div><dt><kbd>Home</kbd> / <kbd>End</kbd></dt><dd>Jump to the first or last item</dd></div><div><dt><kbd>Enter</kbd></dt><dd>Open the focused task</dd></div><div><dt><kbd>Space</kbd></dt><dd>Select or clear the focused task</dd></div><div><dt><kbd>Escape</kbd></dt><dd>Clear the task selection</dd></div></dl></section>
        <section aria-labelledby="keyboard-help-review"><h3 id="keyboard-help-review">Changes review</h3><dl><div><dt><kbd>J</kbd> / <kbd>K</kbd></dt><dd>Next or previous pending decision</dd></div><div><dt><kbd>[</kbd> / <kbd>]</kbd></dt><dd>Previous or next changed file</dd></div><div><dt><kbd>R</kbd></dt><dd>Mark the current decision reviewed</dd></div><div><dt><kbd>D</kbd></dt><dd>Change the diff reading mode</dd></div></dl></section>
        <section aria-labelledby="keyboard-help-panes"><h3 id="keyboard-help-panes">Pane tabs</h3><dl><div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Move between tabs and open that pane</dd></div><div><dt><kbd>Home</kbd> / <kbd>End</kbd></dt><dd>Move to the first or last tab</dd></div><div><dt><kbd>Tab</kbd></dt><dd>Move into the selected pane or to the next control</dd></div></dl></section>
      </div>
    </ModalDialog>
  );
}

export function SettingsDialog({ onClose, onOpenKeyboardShortcuts }: { onClose: () => void; onOpenKeyboardShortcuts: () => void }) {
  return (
    <ModalDialog className="sources-dialog" labelledBy="settings-dialog-title" onClose={onClose}>
      <div className="dialog-header">
        <div><span className="eyebrow">Workbench</span><h2 id="settings-dialog-title">Settings</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button>
      </div>
      <p className="dialog-description">Preferences for how Workbench behaves on this device.</p>
      <div className="connection-list">
        <AiProviderSetting />
        <DesktopNotificationSetting />
        <div className="connection-card">
          <div className="connection-summary">
            <span><strong>Keyboard shortcuts</strong><small>Review search, task queue, changes review, and pane navigation shortcuts.</small></span>
            <button type="button" className="button secondary compact" aria-haspopup="dialog" onClick={onOpenKeyboardShortcuts}>
              <CircleHelp size={13} /> View shortcuts
            </button>
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}
