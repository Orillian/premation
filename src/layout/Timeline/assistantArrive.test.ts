import { assistantArriving, assistantSeen, resetAssistantArrivals } from './assistantArrive';

describe('assistantArriving', () => {
  afterEach(() => {
    resetAssistantArrivals();
    delete document.documentElement.dataset.assistant;
  });

  it('stays still for layers already on screen, and fades only a layer that appears while an assistant works', () => {
    expect(assistantArriving('existing')).toBe(false);
    document.documentElement.dataset.assistant = 'working';
    expect(assistantArriving('existing')).toBe(false);
    expect(assistantArriving('added')).toBe(true);
    expect(assistantArriving('added')).toBe(true);
    assistantSeen(['added']);
    expect(assistantArriving('added')).toBe(false);
  });
});
