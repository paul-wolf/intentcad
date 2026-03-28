import { useState, useEffect, useRef } from 'react';
import type { Part, ExtrudeFeature, RevolveFeature } from '@/types/part';
import type { Document } from '@/types/document';
import { api } from '@/api/cachedClient';
import { evaluateFeatures } from '@/part/featureEngine';
import { renderPartThumbnail } from '@/rendering/partThumbnail';

interface PartThumbnailProps {
  part: Part;
  width: number;
  height: number;
  background?: string;
  stroke?: string;
}

export function PartThumbnail({ part, width, height, background }: PartThumbnailProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const featuresRef = useRef(part.features);

  useEffect(() => {
    featuresRef.current = part.features;
    const features = part.features;
    if (features.length === 0) {
      setDataUrl(null);
      setError(false);
      return;
    }

    let cancelled = false;

    // Fetch all referenced sketch documents
    const docIds = [
      ...new Set(
        features
          .filter((f) => 'sketchDocumentId' in f)
          .map((f) => (f as ExtrudeFeature | RevolveFeature).sketchDocumentId),
      ),
    ];

    Promise.all(
      docIds.map((docId) =>
        api.getDocument(docId).then((full) => [docId, full.data as unknown as Document] as const),
      ),
    )
      .then(async (entries) => {
        if (cancelled) return;
        const docMap = new Map<string, Document>(entries);
        const meshes = await evaluateFeatures(features, docMap);
        if (cancelled) return;
        if (meshes.length === 0) {
          setDataUrl(null);
          return;
        }
        const url = renderPartThumbnail(
          meshes.map((m) => m.geometry),
          width,
          height,
          { background },
        );
        if (!cancelled) {
          setDataUrl(url);
          setError(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setDataUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [part.features, width, height, background]);

  if (error || (!dataUrl && part.features.length === 0)) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: background ?? '#0f172a',
          borderRadius: '3px',
          fontSize: '10px',
          color: '#94a3b8',
        }}
      >
        {part.name}
      </div>
    );
  }

  if (!dataUrl) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: background ?? '#0f172a',
          borderRadius: '3px',
          fontSize: '10px',
          color: '#64748b',
        }}
      >
        Loading...
      </div>
    );
  }

  return (
    <img
      src={dataUrl}
      width={width}
      height={height}
      style={{ borderRadius: '3px', display: 'block' }}
    />
  );
}
