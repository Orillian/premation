import { useEffect, useRef } from 'react';
import { api } from '@core/api/client';
import { documentMirror } from '@stores/documentMirror';
import { captureThumbnailWhenIdle } from './thumbnailCapture';

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Project-thumbnail capture for cloud projects: render the poster frame and
 * upload it.
 *
 * Kept its name, but it is no longer a Web Worker — the worker version never
 * produced a thumbnail (no `document`, and an empty scene graph, inside a
 * worker). The render now runs on the main thread at idle; see
 * thumbnailCapture.ts.
 */
export function CloudThumbnailWorker({ projectId }: { projectId: string }): null {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastCaptureRef = useRef(0);
  const dirtyRef = useRef(false);
  const capturingRef = useRef(false);

  useEffect(() => {
    let cancelCapture: (() => void) | null = null;
    // The bytes last sent: an edit that does not change the poster frame (a
    // later keyframe, a rename) sends nothing. Each upload is a storage write
    // and a CDN invalidation on the server, ~1.2 s.
    let lastSent: Uint8Array | null = null;
    const upload = (blob: Blob | null): void => {
      if (!blob) return;
      void blob.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf);
        if (lastSent && sameBytes(lastSent, bytes)) return;
        lastSent = bytes;
        void api.setProjectThumbnail(projectId, blob).catch(() => {
          lastSent = null;  // not stored: the next capture sends it again
        });
      }, () => undefined);
    };

    const capture = (): void => {
      if (!dirtyRef.current || capturingRef.current) return;
      capturingRef.current = true;
      dirtyRef.current = false;
      cancelCapture = captureThumbnailWhenIdle((blob) => {
        cancelCapture = null;
        capturingRef.current = false;
        upload(blob);
      });
    };

    const onChange = (): void => {
      dirtyRef.current = true;
      if (timerRef.current) return;
      const wait = Math.max(0, 120_000 - (Date.now() - lastCaptureRef.current));
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        capture();
        lastCaptureRef.current = Date.now();
      }, wait);
    };

    // Every document revision (B4: the mirror's `doc` key); a landed video
    // decode is not one.
    const unsubscribe = documentMirror().subscribe(['doc'], onChange);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      unsubscribe();
      // Capture the final thumbnail on unmount so the last edit gets one. Not
      // cancelled with the rest: it is deliberately allowed to finish after
      // the component is gone (the scene is still in memory while it renders).
      const pendingCapture = cancelCapture as (() => void) | null;
      if (dirtyRef.current) {
        pendingCapture?.();
        captureThumbnailWhenIdle(upload);
      }
    };
  }, [projectId]);

  return null;
}
