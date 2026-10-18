/**
 * Can a project snapshot be rendered by the export engine?
 *
 * Every export job runs in `premation-engine --export` from a project written
 * by `ProjectManager.snapshotTo` (the engine's `saveProject`, a bundle for the
 * supervisor's `.motion` path). That process shares nothing with the editor
 * but the disk, so what matters is where each piece of footage lives:
 *
 *  - A path, a `file://` URL, an http(s) URL, a `data:` URL: the engine reads
 *    those itself.
 *  - `motion-blob:<hash>`: bytes in the source project's bundle. The bundle
 *    save copies every referenced blob into the snapshot, so they travel.
 *  - `blob:`: a session object URL, valid only in the window that minted it.
 *    No process but this window can read it — the one thing that cannot travel.
 *
 * The predicate reads no bytes: a file that has gone missing since import
 * still counts as carriable (the job renders that layer offline and records
 * it), because telling the two apart needs I/O a click handler should not do.
 */

/** A footage item, in the only shape this needs. */
export interface LibraryAsset {
  id: string;
  src: string;
}

/** A src only the editor window can read. */
function isSessionLocal(src: string): boolean {
  return src.trim().startsWith('blob:');
}

/** The footage a snapshot could NOT carry to the export engine. Empty means every piece makes it. */
export function uncarriableMedia(footage: ReadonlyArray<LibraryAsset>): LibraryAsset[] {
  return footage.filter((a) => isSessionLocal(a.src));
}

/**
 * The live answer for the open project's footage items (id + media URL — the
 * mirror's `ItemInfo.mediaUrl`). The items are an argument (not a store read):
 * core does not reach into the editor's stores.
 */
export function currentProjectSnapshotIsPortable(footage: ReadonlyArray<LibraryAsset>): boolean {
  return uncarriableMedia(footage).length === 0;
}
