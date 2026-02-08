import { useState, useEffect } from 'react';
import { partApi } from '@/api/client';
import type { Part } from '@/types/part';
import { PartThumbnail } from './PartThumbnail';

interface PartListThumbnailProps {
  partId: string;
  width: number;
  height: number;
  background?: string;
}

export function PartListThumbnail({ partId, width, height, background }: PartListThumbnailProps) {
  const [part, setPart] = useState<Part | null>(null);

  useEffect(() => {
    partApi.getPart(partId)
      .then((full) => setPart(full.data as unknown as Part))
      .catch(() => {});
  }, [partId]);

  if (!part) return <div style={{ width, height }} />;

  return (
    <PartThumbnail
      part={part}
      width={width}
      height={height}
      background={background}
    />
  );
}
