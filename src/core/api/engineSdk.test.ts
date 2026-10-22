/**
 * The store browses with `sdk=ENGINE_PLUGIN_SDK` and the registry lists only
 * plugins whose minor is ≤ it. When the engine's SDK gained 1.2 and this
 * constant stayed 1.1, every plugin built on 1.2 vanished from the Store tab
 * for every account. The header is the source of truth.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_PLUGIN_SDK } from './client';

test('ENGINE_PLUGIN_SDK matches the SDK the engine hosts (pr_types.h)', () => {
  const header = readFileSync(join(process.cwd(), 'native/sdk/include/premation_sdk/pr_types.h'), 'utf8');
  const major = /#define PR_SDK_VERSION_MAJOR +(\d+)/.exec(header)?.[1];
  const minor = /#define PR_SDK_VERSION_MINOR +(\d+)/.exec(header)?.[1];
  expect(major).toBeDefined();
  expect(minor).toBeDefined();
  expect(ENGINE_PLUGIN_SDK).toBe(`${major}.${minor}`);
});
