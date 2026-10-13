/**
 * Export failures in people's words, with a code the UI can hang a button on.
 */

import { explainExportFailure } from './exportFailure';

test.each([
  ['starting the encoder: the executable was not found', 'ffmpeg-unavailable'],
  ['starting the encoder: Permission denied', 'ffmpeg-unavailable'],
  ['proxy: could not start ffmpeg: spawn failed', 'ffmpeg-unavailable'],
  ['The encode failed: ffmpeg exited 1: out.mp4: No space left on device', 'disk-full'],
  ['The encode failed: ffmpeg exited 1: There is not enough space on the disk.', 'disk-full'],
  ['The encode failed: ffmpeg exited 1: C:\\Program Files\\out.mp4: Permission denied', 'output-unwritable'],
  ['opening the output: Access is denied.', 'output-unwritable'],
  ['The process cannot access the file because it is being used by another process', 'output-busy'],
])('%s → %s', (raw, code) => {
  const e = explainExportFailure(raw);
  expect(e.code).toBe(code);
  expect(e.detail).toBe(raw);
  expect(e.message).not.toMatch(/ffmpeg exited|executable|ENOENT/);
});

test('an unknown failure keeps its own words', () => {
  expect(explainExportFailure('The export engine did not start rendering within 60s.')).toEqual({ message: 'The export engine did not start rendering within 60s.' });
});
