/**
 * electron-builder `beforePack`: stage the per-platform, per-arch native
 * payloads the app cannot run without, once per (platform, arch) packaged —
 * macOS packages arm64 and x64 in one call, so this cannot be a step before it.
 *
 *   build/engine/   premation-engine (+ what travels with it)  scripts/stageEngine.cjs
 *   build/ffmpeg/   the ffmpeg export encodes with              scripts/fetchFfmpeg.cjs
 *
 * Either one missing fails the package.
 */

'use strict';

const stageEngine = require('./stageEngine.cjs');
const { stageFfmpeg } = require('./fetchFfmpeg.cjs');

module.exports = async function beforePack(context) {
  await stageEngine(context);
  const platform = context && context.electronPlatformName ? context.electronPlatformName : process.platform;
  const arch = context && context.arch !== undefined ? context.arch : process.arch;
  await stageFfmpeg(platform, arch);
};
