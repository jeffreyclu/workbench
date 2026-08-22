import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrokerConnection } from '../shared/contracts';
import { api } from './api';

function SourceConnectionCard({ connection }: { connection: BrokerConnection }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const provider = connection.id;
  const reconnecting = connection.state === 'error' || connection.state === 'reauth_required';
  const disconnect = useMutation({
    mutationFn: () => api.disconnectSource(provider === 'atlassian' ? 'confluence' : provider === 'slack' || provider === 'figma' ? provider : 'github'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['source-connections'] }),
  });
  const mcpConnect = useMutation({
    mutationFn: async () => {
      // `codex mcp login figma` opens the provider's browser window itself.
      // Opening a Workbench popup as well duplicates the authorization window.
      if (provider === 'figma') {
        await api.startManagedFigmaOAuth();
        return;
      }
      const popup = window.open('about:blank', `workbench-${provider}-oauth`, 'popup,width=720,height=760');
      if (!popup) throw new Error('Popup blocked. Allow popups for Workbench and try again.');
      popup.document.write('<title>Connecting MCP</title><body style="margin:0;background:#10100f;color:#ddd;font:16px system-ui;display:grid;place-items:center;min-height:100vh">Preparing secure MCP authorization…</body>');
      try {
        if (provider === 'slack') {
          popup.location.replace('https://chatgpt.com/#settings/Connectors');
          return;
        }
        const oauthProvider = provider === 'atlassian' ? 'confluence' : null;
        if (!oauthProvider) throw new Error(`${connection.name} does not support MCP authorization here.`);
        if (reconnecting) await api.disconnectSource(oauthProvider);
        const { url } = await api.startMcpOAuth(oauthProvider); popup.location.replace(url);
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
        void queryClient.invalidateQueries({ queryKey: ['source-connections'] });
        setOpen(false);
      }
    };
    window.addEventListener('message', receiveOAuth);
    return () => window.removeEventListener('message', receiveOAuth);
  }, [queryClient]);
  const connected = connection.state === 'connected';
  useEffect(() => {
    if (provider === 'figma' && connected) setOpen(false);
  }, [connected, provider]);
  const disabled = connection.state === 'disabled';
  const canAuthorize = provider === 'atlassian' || provider === 'slack' || provider === 'figma';
  return <div className={`connection-card ${connected ? 'connected' : ''} ${disabled ? 'unavailable' : ''}`}>
    <div className="connection-summary"><span><strong>{connection.name}</strong><small>{connection.detail}</small></span>
      {canAuthorize && connected && provider !== 'slack' ? <button className="button secondary compact" onClick={() => disconnect.mutate()}>Disconnect</button> : canAuthorize ? <button className="button secondary compact" onClick={() => setOpen((value) => !value)}>{open ? 'Cancel' : provider === 'slack' ? 'Manage connection' : reconnecting ? 'Reconnect MCP' : 'Connect MCP'}</button> : <span className="mcp-required">{disabled ? 'Awaiting IT approval' : connected ? 'Connected' : 'Not connected'}</span>}
    </div>
    <div className="connection-meta">{connection.host === 'workbench' ? 'Workbench' : 'Managed connector'}<span>·</span>{connection.capabilities.map((capability) => capability.replace('_', ' ')).join(' · ') || 'Unavailable'}</div>
    {connection.lastError && <p className="error-message">{connection.lastError}</p>}
    {open && canAuthorize && <div className="connection-form mcp-connection-form">
      <button className="button primary" onClick={() => mcpConnect.mutate()} disabled={mcpConnect.isPending}>{mcpConnect.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {provider === 'slack' ? 'Open ChatGPT connections' : 'Authorize MCP'}</button>
      {provider === 'figma' && mcpConnect.isSuccess && <p className="muted">Complete authorization in the Figma window that just opened.</p>}
      {mcpConnect.error && <p className="error-message">Connection failed: {mcpConnect.error.message}</p>}
    </div>}
  </div>;
}

export function SourcesDialog({ onClose }: { onClose: () => void }) {
  const connections = useQuery({ queryKey: ['source-connections'], queryFn: api.listSourceConnections, refetchInterval: 2_000 });
  const linearConnection = connections.data?.connections.find((connection) => connection.id === 'linear');
  const linearConfigured = linearConnection?.state === 'connected';

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog sources-dialog" onMouseDown={(event) => event.stopPropagation()} aria-label="Workbench connections">
        <div className="dialog-header">
          <div><span className="eyebrow">Workbench</span><h2>Connections</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>
        <p className="dialog-description">Workbench uses these connections to resolve links and give agents source context without sending you through their authentication dialogs.</p>
        <div className="connection-list">
          <div className={`connection-card ${linearConfigured ? 'connected' : ''}`}>
            <div className="connection-summary"><span><strong>Linear</strong><small>{linearConfigured ? 'Connected · issues and project context' : 'Add LINEAR_API_KEY to .env to connect'}</small></span>
              <span className="mcp-required">{linearConfigured ? 'Connected' : 'Not connected'}</span>
            </div>
          </div>
          {connections.data?.connections.filter((connection) => connection.id !== 'linear').map((connection) => <SourceConnectionCard key={connection.id} connection={connection} />)}
        </div>
      </section>
    </div>
  );
}
