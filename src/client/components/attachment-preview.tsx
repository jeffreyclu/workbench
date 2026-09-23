import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { attachmentPreviewKind } from '../lib/formatters';
import { requestBlob } from '../data/request';
import type { WorkItem } from '../../shared/contracts';

type Attachment = NonNullable<WorkItem['attachments']>[number];

export function AttachmentLink({ url, file, children }: { url: string; file: Attachment; children: ReactNode }) {
  const [loading, setLoading] = useState(false);
  const open = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const blob = await requestBlob(url);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = file.name;
      anchor.rel = 'noreferrer';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } finally {
      setLoading(false);
    }
  };
  return <button type="button" className="attachment-download-link" onClick={() => void open()} disabled={loading} title={`${file.mimeType} · ${file.size} bytes`}>{loading ? <LoaderCircle className="spin" size={11} /> : children}</button>;
}

export function AttachmentPreview({ url, file }: { url: string; file: Attachment }) {
  const kind = attachmentPreviewKind(file.mimeType);
  const preview = useQuery({
    queryKey: ['attachment-preview', url],
    queryFn: async ({ signal }) => {
      const blob = await requestBlob(url, signal);
      return kind === 'text' ? { text: await blob.text(), blob: null } : { text: null, blob };
    },
    enabled: kind !== 'none',
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!preview.data?.blob) {
      setObjectUrl(null);
      return;
    }
    const next = URL.createObjectURL(preview.data.blob);
    setObjectUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [preview.data?.blob]);

  if (preview.isLoading || (kind !== 'text' && preview.data && !objectUrl)) return <div className="attachment-preview attachment-preview-loading"><LoaderCircle className="spin" size={14} /></div>;
  if (preview.isError) return <p className="error-message">Couldn't load the preview.</p>;
  if (kind === 'image' && objectUrl) return <div className="attachment-preview attachment-preview-image"><img src={objectUrl} alt={file.name} /></div>;
  if (kind === 'pdf' && objectUrl) return <iframe className="attachment-preview attachment-preview-pdf" src={objectUrl} title={file.name} />;
  if (kind === 'text') return <pre className="attachment-preview attachment-preview-text">{preview.data?.text}</pre>;
  return <p className="muted attachment-preview-unsupported">Preview isn't available for this file type. Download it to view the contents.</p>;
}
