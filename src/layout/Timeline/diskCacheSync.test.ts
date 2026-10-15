import { DISK_CACHE_MAX_GB, diskCacheBudgetCommand } from './diskCacheSync';

const prefs = { diskCacheEnabled: true, diskCacheFolder: null as string | null, diskCacheMaxGb: 20 };

describe('diskCacheBudgetCommand', () => {
  it('sends the default folder and the limit in MB when none is chosen', () => {
    expect(diskCacheBudgetCommand(prefs, 'C:/Cache')).toEqual({
      type: 'setCacheBudget', ramMegabytes: 0, diskMegabytes: 20 * 1024, diskPath: 'C:/Cache',
    });
  });

  it('prefers the chosen folder', () => {
    expect(diskCacheBudgetCommand({ ...prefs, diskCacheFolder: 'D:/Fast' }, 'C:/Cache').diskPath).toBe('D:/Fast');
  });

  it('is off when disabled, or with no folder at all', () => {
    expect(diskCacheBudgetCommand({ ...prefs, diskCacheEnabled: false }, 'C:/Cache')).toMatchObject({ diskMegabytes: 0, diskPath: '' });
    expect(diskCacheBudgetCommand(prefs, null)).toMatchObject({ diskMegabytes: 0, diskPath: '' });
  });

  it('clamps the size', () => {
    expect(diskCacheBudgetCommand({ ...prefs, diskCacheMaxGb: 0 }, 'x').diskMegabytes).toBe(1024);
    expect(diskCacheBudgetCommand({ ...prefs, diskCacheMaxGb: 1e9 }, 'x').diskMegabytes).toBe(DISK_CACHE_MAX_GB * 1024);
  });
});
