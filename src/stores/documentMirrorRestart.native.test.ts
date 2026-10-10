/**
 * The mirror after an engine restart whose refetch failed.
 *
 * The bug (2026-10-10, a hang/crash loop): the `documentReset{engineRestarted}`
 * refetch came back `busy`, the mirror kept the dead engine's revision, and
 * the restarted engine numbered from below it — so every later batch looked
 * like one already applied and was dropped. New layers never reached the
 * timeline (the engine had them) until the revisions caught up.
 */

import { ProcessEngineClient, unwrap, type EngineResult, type EventBatch, type QueryOf, type QueryResults, type QueryType } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';
import { DocumentMirror, type MirrorSource } from './documentMirror';

const describeNative = nativeEngineExe() ? describe : describe.skip;

/** A source whose engine can be swapped for a fresh one, and whose next getDocument can fail. */
class SwappableSource implements MirrorSource {
  failNextDocument = false;
  private readonly listeners = new Set<(b: EventBatch) => void>();
  private off: () => void;
  constructor(public client: ProcessEngineClient) {
    this.off = client.subscribe((b) => this.emit(b));
  }
  swap(client: ProcessEngineClient): void {
    this.off();
    this.client = client;
    this.off = client.subscribe((b) => this.emit(b));
  }
  emit(b: EventBatch): void {
    for (const l of this.listeners) l(b);
  }
  subscribe(listener: (b: EventBatch) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  query<T extends QueryType>(q: QueryOf<T>): Promise<EngineResult<QueryResults[T]>> {
    if (q.type === 'getDocument' && this.failNextDocument) {
      this.failNextDocument = false;
      return Promise.resolve({ ok: false, error: { code: 'busy', message: 'engine unreachable' }, revision: 0 } as EngineResult<QueryResults[T]>);
    }
    return this.client.query(q);
  }
}

describeNative('the document mirror after an engine restart', () => {
  const natives: NativeEngine[] = [];
  const clients: ProcessEngineClient[] = [];

  async function engine(): Promise<ProcessEngineClient> {
    const n = await startNativeEngine();
    natives.push(n);
    const c = new ProcessEngineClient(n.bridge);
    clients.push(c);
    await c.whenReady();
    return c;
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close();
    for (const n of natives.splice(0)) await n.stop();
  });

  const compOf = new Map<ProcessEngineClient, string>();
  async function layerIn(c: ProcessEngineClient, name: string): Promise<{ comp: string; layer: string }> {
    let comp = compOf.get(c);
    if (!comp) {
      comp = unwrap(await c.execute({ type: 'createComposition', settings: { name: 'Main', width: 640, height: 360 }, fromItems: [] })).item;
      compOf.set(c, comp);
    }
    const { layer } = unwrap(await c.execute({ type: 'createLayer', comp, kind: 'solid', name, init: [] }));
    return { comp, layer };
  }

  it('shows layers made after a restart whose refetch failed, though the new engine numbers from below the old one', async () => {
    const before = await engine();
    const source = new SwappableSource(before);
    const m = new DocumentMirror(source).start();
    await m.whenIdle();
    for (let i = 0; i < 6; i++) await layerIn(before, `Old ${i}`);
    await m.whenIdle();
    expect(m.layerIds()).toHaveLength(6);

    // The engine is replaced by one that starts over (a lower revision), and
    // the mirror's refetch after the reset fails.
    const after = await engine();
    source.swap(after);
    source.failNextDocument = true;
    const rev = (await after.query({ type: 'getHistory' })).revision;
    source.emit({ fromRevision: rev, toRevision: rev, events: [{ type: 'documentReset', revision: rev, reason: 'engineRestarted' }], origin: 'engine' } as EventBatch);
    await m.whenIdle();

    const { layer } = await layerIn(after, 'New');
    await m.whenIdle();
    await m.whenAt((await after.query({ type: 'getHistory' })).revision);
    await m.whenIdle();
    expect(m.status).toBe('ready');
    expect(m.layerIds()).toContain(layer);
    expect(m.layerIds()).toHaveLength(1);
  }, 60_000);

  it('asks again on its own when no edit follows the failed refetch', async () => {
    const before = await engine();
    const source = new SwappableSource(before);
    const m = new DocumentMirror(source).start();
    await layerIn(before, 'Old');
    await m.whenIdle();
    expect(m.layerIds()).toHaveLength(1);

    const after = await engine();
    const { layer } = await layerIn(after, 'Restored');
    source.swap(after);
    source.failNextDocument = true;
    const rev = (await after.query({ type: 'getHistory' })).revision;
    source.emit({ fromRevision: rev, toRevision: rev, events: [{ type: 'documentReset', revision: rev, reason: 'engineRestarted' }], origin: 'engine' } as EventBatch);
    await m.whenIdle();
    expect(m.status).toBe('error');
    const t0 = Date.now();
    while (m.status !== 'ready' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    await m.whenIdle();
    expect({ status: m.status, error: m.error }).toEqual({ status: 'ready', error: null });
    expect(m.layerIds()).toEqual([layer]);
  }, 60_000);
});
