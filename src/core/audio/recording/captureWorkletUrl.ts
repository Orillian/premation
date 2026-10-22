/**
 * Where the capture worklet is served from. Its own module, like
 * `spawnScriptWorker.ts`, because `import.meta.url` does not parse under the
 * CommonJS test build — tests mock this file.
 *
 * `new URL('./x.js', import.meta.url)` is the Vite pattern that emits the
 * file as a hashed asset next to the bundle (served from 'self', which the
 * page's `script-src 'self'` policy allows; a blob: module would not be).
 */
export function captureWorkletUrl(): string {
  return new URL('./captureWorklet.js', import.meta.url).href;
}
