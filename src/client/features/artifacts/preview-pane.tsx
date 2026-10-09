import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownCode, MarkdownPre } from '../../components/markdown/markdown-code.js';
import { requestBlob } from '../../data/request';
import { artifactContentPath, artifactPreviewKind, limitPreviewText } from './preview-logic';
import type { ArtifactSummary } from '../../../shared/contracts';

function ExternalFallback({ artifact, message }: { artifact: ArtifactSummary; message: string }) {
  return (
    <div className="artifact-preview-fallback">
      <p className="muted">{message}</p>
      {!artifact.revokedAt && <a className="button secondary compact" href={artifact.url} target="_blank" rel="noreferrer"><ArrowUpRight size={13} /> Open externally</a>}
    </div>
  );
}

function PreviewBody({ artifact }: { artifact: ArtifactSummary }) {
  const kind = artifactPreviewKind(artifact.sourcePath);
  const content = useQuery({
    queryKey: ['artifact-preview', artifact.id, artifact.version],
    queryFn: async ({ signal }) => {
      const blob = await requestBlob(artifactContentPath(artifact.sourcePath, artifact.workItemId), signal);
      return kind === 'image' ? { text: null, blob } : { text: limitPreviewText(await blob.text()), blob: null };
    },
    enabled: kind !== 'none',
    retry: false,
  });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!content.data?.blob) { setImageUrl(null); return; }
    const next = URL.createObjectURL(content.data.blob);
    setImageUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [content.data?.blob]);

  if (kind === 'none') return <ExternalFallback artifact={artifact} message="Preview isn't available for this file type." />;
  if (content.isLoading) return <div className="artifact-preview-loading"><LoaderCircle className="spin" size={14} /></div>;
  if (content.isError || !content.data) return <ExternalFallback artifact={artifact} message="Couldn't load the preview. The source file may have moved." />;
  if (content.data.blob) return imageUrl ? <div className="artifact-preview-image"><img src={imageUrl} alt={artifact.title} /></div> : null;
  const { text, truncated } = content.data.text!;
  return (
    <>
      {kind === 'markdown'
        ? <div className="artifact-preview-markdown message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode, pre: MarkdownPre }}>{text}</ReactMarkdown></div>
        : <pre className="artifact-preview-text" tabIndex={0}>{text}</pre>}
      {truncated && <p className="muted artifact-preview-truncated">Preview truncated. Open the artifact to see the rest.</p>}
    </>
  );
}

export function ArtifactPreviewPane({ artifact, onClose }: { artifact: ArtifactSummary; onClose: () => void }) {
  return (
    <aside className="artifact-preview-pane" aria-label={`Preview of ${artifact.title}`}>
      <header>
        <strong title={artifact.sourcePath}>{artifact.title}</strong>
        {!artifact.revokedAt && <a className="icon-button" href={artifact.url} target="_blank" rel="noreferrer" aria-label="Open shared page" title="Open shared page"><ArrowUpRight size={14} /></a>}
        <button type="button" className="icon-button" aria-label="Close preview" title="Close preview" onClick={onClose}><X size={14} /></button>
      </header>
      <PreviewBody key={`${artifact.id}-${artifact.version}`} artifact={artifact} />
    </aside>
  );
}
