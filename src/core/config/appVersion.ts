/**
 * The app's version, from package.json: the loading screen's corner, the
 * About dialog and analytics all say the same number.
 */

import pkg from '../../../package.json';

export const APP_VERSION: string = (pkg as { version?: string }).version ?? '0.0.0';
