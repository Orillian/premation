import { parseUriList, readClipboardFilePaths, type ClipboardLike } from './clipboardFiles';

const isWin = process.platform === 'win32';

describe('files on the OS clipboard', () => {
  it('reads every file of a uri-list, skipping comments and non-file URLs', () => {
    const list = isWin
      ? 'file:///C:/Users/me/a%20b.png\r\n# comment\r\nhttps://example.com/x.png\r\nfile:///C:/Users/me/c.mp4'
      : 'file:///home/me/a%20b.png\n# comment\nhttps://example.com/x.png\nfile:///home/me/c.mp4';
    expect(parseUriList(list)).toEqual(isWin ? ['C:\\Users\\me\\a b.png', 'C:\\Users\\me\\c.mp4'] : ['/home/me/a b.png', '/home/me/c.mp4']);
  });

  it('reads the uri-list flavour of the clipboard (Electron 44 clipboard.read)', async () => {
    const url = isWin ? 'file:///C:/x/one.png\r\nfile:///C:/x/two.jpg' : 'file:///x/one.png\nfile:///x/two.jpg';
    const clip: ClipboardLike = {
      read: async () => [{ types: ['text/uri-list', 'text/plain'], getType: async () => ({ text: async () => url }) }],
    };
    expect(await readClipboardFilePaths(clip)).toHaveLength(2);
  });

  it('answers none for text, an image, or a clipboard that throws', async () => {
    const text: ClipboardLike = { read: async () => [{ types: ['text/plain'], getType: async () => ({ text: async () => 'hi' }) }] };
    const broken: ClipboardLike = { read: async () => { throw new Error('denied'); } };
    expect(await readClipboardFilePaths(text)).toEqual([]);
    expect(await readClipboardFilePaths(broken)).toEqual([]);
  });
});
