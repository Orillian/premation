/**
 * Animation ▸ Animate ▸ Create Carousel ▸ Ring / Ferris Wheel / Cover Flow /
 * Card Stack — the command palette / menu entries over `createCarouselEdit`
 * (carousel.ts).
 */

import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { useUIStore } from '@stores/uiStore';
import { useSelectionStore } from '@stores/selectionStore';
import { CAROUSEL_MODES, createCarouselEdit } from './carousel';

function notify(message: string, level: 'info' | 'success' | 'warning'): void {
  useUIStore.getState().notify({ level, message, durationMs: 5000 });
}

export function buildCarouselCommands(): ReadonlyArray<Command> {
  return CAROUSEL_MODES.map(({ mode, label, description }) => ({
    id: asCommandId(`animation.createCarousel.${mode}`),
    label: `Create Carousel: ${label}`,
    description: `${description}. Steer it with the Size, Speed, Spin and Angle sliders on the Carousel null`,
    icon: 'orbit',
    enabled: () => useSelectionStore.getState().ids.length >= 2,
    execute: async () => {
      const ids = useSelectionStore.getState().ids;
      if (ids.length < 2) {
        notify('Select two or more layers in the same composition to make a carousel', 'warning');
        return;
      }
      const made = await createCarouselEdit(ids, mode);
      if (!made) {
        notify('Could not create the carousel — pick two or more layers (not cameras or lights) from one composition', 'warning');
        return;
      }
      useSelectionStore.getState().set([made.controls]);
      notify(
        `${label} carousel built with ${made.cards.length} cards — steer it with the sliders on "${made.names.size.replace(' Size', '')}" (keyframe Spin for an eased stop)`,
        'success',
      );
    },
  }));
}
