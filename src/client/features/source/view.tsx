import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, LoaderCircle, X } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import type { BrokerConnection } from '../../../shared/contracts';
import { sourceData, sourceQueryKeys } from './data';
import { useSourceAuthorization, useSourceConnections } from './hooks';
import { canAuthorizeSource, sourceDisconnectProvider, usesManagedAuthorization, type SourceAuthorizationState } from './state';
import { ModalDialog } from '../../components/dialogs/modal-dialog';
import { ConfirmationDialog } from '../../components/dialogs/confirmation-dialog';
import { Skeleton } from '../../components/skeleton/skeleton';
import { toastError } from '../../state/toast-store';

function SourceConnectionCardSkeleton() {
  return (
    <div className="connection-card" data-testid="connection-card-skeleton" aria-hidden="true">
      <div className="connection-summary">
        <span><Skeleton width="96px" height="14px" /><Skeleton width="180px" height="11px" /></span>
        <Skeleton width="82px" height="28px" radius="6px" />
      </div>
      <div className="connection-meta"><Skeleton width="120px" height="10px" /></div>
    </div>
  );
}

const AuthorizationStatusCard = memo(function AuthorizationStatusCard({
  connectionName,
  state,
  onCheck,
}: {
  connectionName: string;
  state: Exclude<SourceAuthorizationState, { status: 'idle' }>;
  onCheck: () => void;
}) {
  const checking = state.status === 'check-auth';
  const authorized = state.status === 'authorized';
  const failed = state.status === 'failed';
  const title = authorized
    ? `${connectionName} authorized`
    : failed
      ? 'Authorization check failed'
      : checking
        ? 'Checking authorization…'
        : `Waiting for ${connectionName} authorization`;
  const detail = authorized
    ? 'The connection is ready to use.'
    : failed
      ? state.error
      : 'Finish authorization in the browser on this Mac. Workbench will keep checking automatically.';

  return (
    <div className={`authorization-status-card ${state.status}`} role="status" aria-live="polite">
      <div className="authorization-status-copy">
        {authorized ? <Check size={16} aria-hidden="true" /> : checking ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <span className="authorization-status-dot" aria-hidden="true" />}
        <span><strong>{title}</strong><small>{detail}</small></span>
      </div>
      {!authorized && <div className="authorization-status-actions">
        <a href={state.authorizationUrl} target="_blank" rel="noreferrer">Open authorization page</a>
        <button type="button" className="button secondary compact" onClick={onCheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>}
    </div>
  );
});

function SourceConnectionCard({ connection }: { connection: BrokerConnection }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [disconnectPromptOpen, setDisconnectPromptOpen] = useState(false);
  const provider = connection.id;
  const authorization = useSourceAuthorization(connection);
  const [grafanaToken, setGrafanaToken] = useState('');
  const reconnecting = connection.state === 'reauth_required';
  const disconnect = useMutation({
    mutationFn: () => sourceData.disconnect(sourceDisconnectProvider(provider)),
    onSuccess: () => { setDisconnectPromptOpen(false); queryClient.invalidateQueries({ queryKey: sourceQueryKeys.connections }); },
    onError: (error) => toastError(`Could not disconnect ${connection.name}.`, error),
  });
  const mcpConnect = useMutation({
    mutationFn: async () => {
      if (provider === 'grafana') {
        await sourceData.configureGrafana(grafanaToken);
        return null;
      }
      // Figma and Atlassian authorize once through Workbench's loopback OAuth.
      // Both coding agents then consume the same Workbench-owned connection.
      if (provider === 'figma' || provider === 'atlassian') {
        const result = await sourceData.startMcpOAuth(provider === 'atlassian' ? 'confluence' : provider);
        return 'connected' in result ? null : result.url;
      }
      const popup = window.open('about:blank', `workbench-${provider}-oauth`, 'popup,width=720,height=760');
      if (!popup) throw new Error('Popup blocked. Allow popups for Workbench and try again.');
      popup.document.write('<title>Connecting MCP</title><body style="margin:0;background:#10100f;color:#ddd;font:16px system-ui;display:grid;place-items:center;min-height:100vh">Preparing secure MCP authorization…</body>');
      try {
        if (provider === 'slack') {
          popup.location.replace('https://chatgpt.com/#settings/Connectors');
          return null;
        }
        throw new Error(`${connection.name} does not support MCP authorization here.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not start MCP authorization.';
        popup.document.body.textContent = `Connection failed: ${message}`;
        throw error;
      }
    },
    onSuccess: (authorizationUrl) => {
      void queryClient.invalidateQueries({ queryKey: sourceQueryKeys.connections });
      if (provider === 'grafana') setOpen(false);
      if (authorizationUrl && usesManagedAuthorization(provider)) authorization.startAuthorization(authorizationUrl);
    },
  });
  useEffect(() => {
    const receiveOAuth = (event: MessageEvent) => {
      if (event.data?.type === 'workbench:slack-connected' || event.data?.type === 'workbench:mcp-connected') {
        void queryClient.invalidateQueries({ queryKey: sourceQueryKeys.connections });
        setOpen(false);
      }
    };
    window.addEventListener('message', receiveOAuth);
    return () => window.removeEventListener('message', receiveOAuth);
  }, [queryClient]);
  const connected = connection.state === 'connected';
  useEffect(() => {
    if ((provider === 'figma' || provider === 'atlassian') && connected) setOpen(false);
  }, [connected, provider]);
  const disabled = connection.state === 'disabled';
  const canAuthorize = canAuthorizeSource(provider);
  const figmaScope = useQuery({ queryKey: sourceQueryKeys.figmaScope, queryFn: sourceData.getFigmaScope, enabled: provider === 'figma' && connected });
  const [figmaRoots, setFigmaRoots] = useState('');
  useEffect(() => {
    if (figmaScope.data) setFigmaRoots(figmaScope.data.roots.join('\n'));
  }, [figmaScope.data]);
  const saveFigmaScope = useMutation({
    mutationFn: () => sourceData.updateFigmaScope(figmaRoots.split('\n').map((root) => root.trim()).filter(Boolean)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sourceQueryKeys.figmaScope }),
    onError: (error) => toastError('Could not save the Figma scope.', error),
  });
  return <div className={`connection-card ${connected ? 'connected' : ''} ${disabled ? 'unavailable' : ''}`}>
    <div className="connection-summary"><span><strong>{connection.name}</strong><small>{connection.detail}</small></span>
      {canAuthorize && connected && provider !== 'slack' ? <button className="button secondary compact danger" onClick={() => setDisconnectPromptOpen(true)} disabled={disconnect.isPending}>{disconnect.isPending ? <LoaderCircle className="spin" size={14} /> : null} Disconnect</button> : canAuthorize ? <button className="button secondary compact" onClick={() => setOpen((value) => !value)}>{open ? 'Cancel' : provider === 'slack' ? 'Manage connection' : reconnecting ? 'Reconnect MCP' : 'Connect MCP'}</button> : <span className="mcp-required">{disabled ? 'Awaiting IT approval' : connected ? 'Connected' : 'Not connected'}</span>}
    </div>
    <div className="connection-meta">{connection.host === 'workbench' ? 'Workbench' : 'Managed connector'}<span>·</span>{connection.capabilities.map((capability) => capability.replace('_', ' ')).join(' · ') || 'Unavailable'}</div>
    {connection.lastError && <p className="error-message">{connection.lastError}</p>}
    {disconnect.error && <p className="error-message">Could not disconnect: {disconnect.error.message}</p>}
    {authorization.state.status !== 'idle' && <AuthorizationStatusCard
      connectionName={connection.name}
      state={authorization.state}
      onCheck={authorization.checkAuthorization}
    />}
    {provider === 'figma' && connected && <div className="connection-form figma-scope-form">
      <label htmlFor="figma-scope">Discovery scope <span>One Figma file, page, or node URL per line.</span></label>
      {figmaScope.isLoading ? <div className="figma-scope-skeleton" aria-hidden="true"><Skeleton width="100%" height="12px" /><Skeleton width="74%" height="12px" /><Skeleton width="58%" height="12px" /></div> : <textarea id="figma-scope" value={figmaRoots} onChange={(event) => setFigmaRoots(event.target.value)} placeholder="https://www.figma.com/design/..." rows={3} />}
      <div className="connection-form-actions"><button className="button secondary compact" onClick={() => saveFigmaScope.mutate()} disabled={saveFigmaScope.isPending}>{saveFigmaScope.isPending ? <LoaderCircle className="spin" size={14} /> : null} Save scope</button>{saveFigmaScope.isSuccess && <small className="muted">Saved.</small>}</div>
      <p className="muted">Figma cannot search your whole workspace. Discovery only inspects the URLs listed here.</p>
      {figmaScope.error && <p className="error-message">Could not load Figma scope: {figmaScope.error.message}</p>}
      {saveFigmaScope.error && <p className="error-message">Could not save Figma scope: {saveFigmaScope.error.message}</p>}
    </div>}
    {open && canAuthorize && <div className="connection-form mcp-connection-form">
      {provider === 'grafana' && <label htmlFor="grafana-token">Service-account token <input id="grafana-token" type="password" autoComplete="off" value={grafanaToken} onChange={(event) => setGrafanaToken(event.target.value)} placeholder="glsa_…" /></label>}
      <button className="button primary" onClick={() => mcpConnect.mutate()} disabled={mcpConnect.isPending || (provider === 'grafana' && !grafanaToken.trim())}>{mcpConnect.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {provider === 'grafana' ? 'Save Grafana token' : provider === 'slack' ? 'Open ChatGPT connections' : 'Authorize MCP'}</button>
      {mcpConnect.error && <p className="error-message">Connection failed: {mcpConnect.error.message}</p>}
    </div>}
    {disconnectPromptOpen && <ConfirmationDialog
      title={`Disconnect ${connection.name}?`}
      description="Workbench will lose access to this source until you reconnect it."
      confirmLabel="Disconnect"
      pending={disconnect.isPending}
      onClose={() => setDisconnectPromptOpen(false)}
      onConfirm={() => disconnect.mutate()}
    />}
  </div>;
}

export function SourcesDialog({ onClose }: { onClose: () => void }) {
  const connections = useSourceConnections();
  const linearConnection = connections.data?.connections.find((connection) => connection.id === 'linear');
  const linearConfigured = linearConnection?.state === 'connected';

  return (
    <ModalDialog className="sources-dialog" labelledBy="sources-dialog-title" onClose={onClose}>
        <div className="dialog-header">
          <div><span className="eyebrow">Workbench</span><h2 id="sources-dialog-title">Connections</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>
        <p className="dialog-description">Workbench uses these connections to resolve links and give agents source context without sending you through their authentication dialogs.</p>
        <div className="connection-list">
          {connections.isLoading ? <>
            <SourceConnectionCardSkeleton />
            <SourceConnectionCardSkeleton />
          </> : connections.isError ? (
            <div className="list-state error-message">Could not load connections. Check your network and try again. <button type="button" className="button secondary compact" onClick={() => connections.refetch()}>Retry</button></div>
          ) : <>
            <div className={`connection-card ${linearConfigured ? 'connected' : ''}`}>
              <div className="connection-summary"><span><strong>Linear</strong><small>{linearConfigured ? 'Connected · issues and project context' : 'Add LINEAR_API_KEY to .env to connect'}</small></span>
                <span className="mcp-required">{linearConfigured ? 'Connected' : 'Not connected'}</span>
              </div>
            </div>
            {connections.data?.connections.filter((connection) => connection.id !== 'linear').map((connection) => <SourceConnectionCard key={connection.id} connection={connection} />)}
          </>}
        </div>
    </ModalDialog>
  );
}
