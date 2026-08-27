import { useQuery } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { attachmentPreviewKind } from './formatters';
import type { WorkItem } from '../shared/contracts';

type Attachment = NonNullable<WorkItem['attachments']>[number];

export function AttachmentPreview({ url, file }: { url: string; file: Attachment }) {
  const kind = attachmentPreviewKind(file.mimeType);
  const textPreview = useQuery({
    queryKey: ['attachment-preview-text', url],
    queryFn: async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to load preview.');
      return response.text();
    },
    enabled: kind === 'text',
  });

  if (kind === 'image') return <div className="attachment-preview attachment-preview-image"><img src={url} alt={file.name} loading="lazy" /></div>;
  if (kind === 'pdf') return <iframe className="attachment-preview attachment-preview-pdf" src={url} title={file.name} />;
  if (kind === 'text') {
    if (textPreview.isLoading) return <div className="attachment-preview attachment-preview-loading"><LoaderCircle className="spin" size={14} /></div>;
    if (textPreview.isError) return <p className="error-message">Couldn't load the preview.</p>;
    return <pre className="attachment-preview attachment-preview-text">{textPreview.data}</pre>;
  }
  return <p className="muted attachment-preview-unsupported">Preview isn't available for this file type. Download it to view the contents.</p>;
}
