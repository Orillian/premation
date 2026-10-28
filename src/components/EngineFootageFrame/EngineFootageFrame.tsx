/**
 * A footage frame drawn by the ENGINE, for panels whose browser <video> cannot
 * play the file (browserPlayable.ts). One request in flight at a time: while it
 * decodes, a newer time replaces the queued one (latest wins, so a fast scrub
 * skips frames instead of queueing them), and the previous picture stays up so
 * the view never flashes empty. Object URLs are revoked as soon as the next
 * picture replaces them.
 */

import { useEffect, useRef, useState } from 'react';
import { engineFootageStill } from '@core/engine/engineStill';

export interface EngineFootageFrameProps {
  itemId: string;
  /** Source seconds. */
  seconds: number;
  /** Long side of the decoded picture, px. */
  maxSize?: number;
  className?: string;
  alt: string;
  onSize?: (size: { width: number; height: number }) => void;
}

export function EngineFootageFrame({ itemId, seconds, maxSize = 1280, className, alt, onSize }: EngineFootageFrameProps): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const want = useRef<{ itemId: string; seconds: number; maxSize: number } | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const onSizeRef = useRef(onSize);
  onSizeRef.current = onSize;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    want.current = { itemId, seconds, maxSize };
    if (busy.current) return;
    const pump = async (): Promise<void> => {
      busy.current = true;
      try {
        while (want.current && alive.current) {
          const job = want.current;
          want.current = null;
          const blob = await engineFootageStill(job.itemId, job.seconds, job.maxSize);
          if (!alive.current) return;
          // Shown even when a newer time is queued: it is newer than what is up,
          // and while playing a newer time is ALWAYS queued.
          if (blob) {
            const next = URL.createObjectURL(blob);
            setUrl((prev) => {
              if (prev) URL.revokeObjectURL(prev);
              return next;
            });
          }
        }
      } finally {
        busy.current = false;
      }
    };
    void pump();
  }, [itemId, seconds, maxSize]);

  // The last picture's URL goes with the component.
  useEffect(() => () => { setUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; }); }, []);

  return url ? (
    <img
      className={className}
      src={url}
      alt={alt}
      draggable={false}
      onLoad={(e) => onSizeRef.current?.({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
    />
  ) : (
    <div className={className} aria-busy="true" aria-label={alt} />
  );
}

export default EngineFootageFrame;
