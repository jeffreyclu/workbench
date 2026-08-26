import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrokerConnection } from '../../../shared/contracts';
import { sourceData, sourceQueryKeys } from './data';
import { useSourceConnections } from './hooks';
import { canAuthorizeSource, sourceDisconnectProvider } from './state';
import { ModalDialog } from '../../modal-dialog';
import { ConfirmationDialog } from '../../confirmation-dialog';
import { Skeleton } from '../../skeleton';
import { toastError } from '../../toast-store';

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

function SourceConnectionCard({ connection }: { connection: BrokerConnection }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [disconnectPromptOpen, setDisconnectPromptOpen] = useState(false);
  const provider = connection.id;
  const reconnecting = connection.state === 'error' || connection.state === 'reauth_required';
  const disconnect = useMutation({
    mutationFn: () => sourceData.disconnect(sourceDisconnectProvider(provider)),
    onSuccess: () => { setDisconnectPromptOpen(false); queryClient.invalidateQueries({ queryKey: sourceQueryKeys.connections }); },
    onError: (error) => toastError(`Could not disconnect ${connection.name}.`, error),
  });
  const mcpConnect = useMutation({
    mutationFn: async () => {
      // Figma, Atlassian, and Grafana authorize through Codex's own loopback OAuth, which
      // opens the provider's browser window itself. Workbench keeps the returned
      // URL so it can be opened manually if that window never appears.
      if (provider === 'figma' || provider === 'atlassian' || provider === 'grafana') {
        if (reconnecting && provider === 'atlassian') await sourceData.disconnect('confluence');
        const { url } = await sourceData.startManagedMcpOAuth(provider);
        return url;
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
    if ((provider === 'figma' || provider === 'atlassian' || provider === 'grafana') && connected) setOpen(false);
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
    {provider === 'figma' && connected && <div className="connection-form figma-scope-form">
      <label htmlFor="figma-scope">Discovery scope <span>One Figma file, page, or node URL per line.</span></label>
      {figmaScope.isLoading ? <div className="figma-scope-skeleton" aria-hidden="true"><Skeleton width="100%" height="12px" /><Skeleton width="74%" height="12px" /><Skeleton width="58%" height="12px" /></div> : <textarea id="figma-scope" value={figmaRoots} onChange={(event) => setFigmaRoots(event.target.value)} placeholder="https://www.figma.com/design/..." rows={3} />}
      <div className="connection-form-actions"><button className="button secondary compact" onClick={() => saveFigmaScope.mutate()} disabled={saveFigmaScope.isPending}>{saveFigmaScope.isPending ? <LoaderCircle className="spin" size={14} /> : null} Save scope</button>{saveFigmaScope.isSuccess && <small className="muted">Saved.</small>}</div>
      <p className="muted">Figma cannot search your whole workspace. Discovery only inspects the URLs listed here.</p>
      {figmaScope.error && <p className="error-message">Could not load Figma scope: {figmaScope.error.message}</p>}
      {saveFigmaScope.error && <p className="error-message">Could not save Figma scope: {saveFigmaScope.error.message}</p>}
    </div>}
    {open && canAuthorize && <div className="connection-form mcp-connection-form">
      <button className="button primary" onClick={() => mcpConnect.mutate()} disabled={mcpConnect.isPending}>{mcpConnect.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {provider === 'slack' ? 'Open ChatGPT connections' : 'Authorize MCP'}</button>
      {mcpConnect.isSuccess && mcpConnect.data && <p className="muted">Approve access in the {connection.name} window that just opened. If it did not appear, <a href={mcpConnect.data} target="_blank" rel="noreferrer">open the authorization page</a> in this browser — it must be this Mac, because the callback returns to 127.0.0.1.</p>}
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
