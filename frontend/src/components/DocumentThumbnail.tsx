import { useState, useEffect } from 'react';
import { api } from '@/api/cachedClient';
import type { Document } from '@/types/document';
import { SketchThumbnail } from './SketchThumbnail';

interface DocumentThumbnailProps {
  documentId: string;
  width: number;
  height: number;
  background?: string;
  stroke?: string;
}

export function DocumentThumbnail({ documentId, width, height, background, stroke }: DocumentThumbnailProps) {
  const [doc, setDoc] = useState<Document | null>(null);

  useEffect(() => {
    api.getDocument(documentId)
      .then((full) => setDoc(full.data as unknown as Document))
      .catch(() => {});
  }, [documentId]);

  if (!doc) return <div style={{ width, height }} />;

  // Find the active sketch, or the first one with entities
  const sketch = doc.sketches.find((s) => s.id === doc.activeSketchId && s.entities.length > 0)
    ?? doc.sketches.find((s) => s.entities.length > 0);

  if (!sketch) return <div style={{ width, height, borderRadius: '3px', background: background ?? '#1e293b' }} />;

  return (
    <SketchThumbnail
      sketch={sketch}
      width={width}
      height={height}
      background={background}
      stroke={stroke}
    />
  );
}
