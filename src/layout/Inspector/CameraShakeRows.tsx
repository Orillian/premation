/**
 * CameraShakeRows — the camera's procedural Shake (camera program R1), a
 * "Shake" twirl the UI lane mounts in CameraSection.
 *
 *   ▶ Shake: Amount · Rotation · Frequency · Seed   [New Seed] [Off]
 *
 * The engine evaluates the shake (seeded smooth noise, two fixed octaves,
 * added after the aim — native/libs/motion_transform `apply_camera_shake`), so
 * these rows only write four keyframeable Transform props through the engine
 * API. Amount and Rotation at 0 = no shake, and nothing is stored for a camera
 * that never shook (goldens stay byte-identical).
 */

import { t } from '@core/i18n';
import { useComponentProp, writeComponentProps } from './useComponentProp';
import { componentOfType } from '@core/engine/propRefs';
import { Button } from '@components/Button';
import { TwirlGroup } from './appearance/TwirlGroup';
import { KeyframeRow } from './KeyframeRow';
import styles from './TransformSection.module.css';

const TRANSFORM = { type: 'Transform' } as const;

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function CameraShakeRows({ nodeId }: { nodeId: string }): JSX.Element {
  const [amountRaw, setAmount] = useComponentProp(nodeId, TRANSFORM, 'shakeAmount');
  const [rotationRaw, setRotation] = useComponentProp(nodeId, TRANSFORM, 'shakeRotation');
  const [frequencyRaw, setFrequency] = useComponentProp(nodeId, TRANSFORM, 'shakeFrequency');
  const [seedRaw, setSeed] = useComponentProp(nodeId, TRANSFORM, 'shakeSeed');
  const amount = num(amountRaw, 0);
  const rotation = num(rotationRaw, 0);
  const frequency = num(frequencyRaw, 2);
  const seed = num(seedRaw, 0);
  const shaking = amount !== 0 || rotation !== 0;

  return (
    <TwirlGroup
      prefKey="camera.shake"
      label={<span title={t('inspector.cameraShake.hint', 'Handheld shake the engine adds after the camera\'s aim: seeded smooth noise, deterministic for a seed. Keyframe Amount to ramp it in or out; camera motion blur sees it.')}>{t('inspector.cameraShake.shake', 'Shake')}</span>}
      defaultOpen={shaking}
      summary={shaking ? `${amount} px · ${rotation}°` : t('inspector.cameraShake.off', 'Off')}
    >
      <KeyframeRow nodeId={nodeId} prop="shakeAmount" label={t('inspector.cameraShake.amount', 'Amount')} value={amount} unit="px" min={0} onStatic={(v) => setAmount(v)} />
      <KeyframeRow nodeId={nodeId} prop="shakeRotation" label={t('inspector.cameraShake.rotation', 'Rotation')} value={rotation} unit="°" min={0} max={45} onStatic={(v) => setRotation(v)} />
      <KeyframeRow nodeId={nodeId} prop="shakeFrequency" label={t('inspector.cameraShake.frequency', 'Frequency')} value={frequency} unit="Hz" min={0} max={30} onStatic={(v) => setFrequency(v)} />
      <KeyframeRow nodeId={nodeId} prop="shakeSeed" label={t('inspector.cameraShake.seed', 'Seed')} value={seed} min={0} precision={0} onStatic={(v) => setSeed(Math.round(v))} />
      <div className={styles.actionRow}>
        <Button
          size="sm"
          variant="secondary"
          title={t('inspector.cameraShake.newSeedHint', 'Pick a different random pattern — same strength, new motion')}
          onClick={() => setSeed(seed + 1)}
        >
          {t('inspector.cameraShake.newSeed', 'New Seed')}
        </Button>
        {shaking && (
          <Button
            size="sm"
            variant="secondary"
            title={t('inspector.cameraShake.offHint', 'Turn the shake off (back to no stored shake)')}
            onClick={() => writeComponentProps(nodeId, componentOfType(nodeId, 'Transform') ?? '', { shakeAmount: undefined, shakeRotation: undefined }, 'Remove Camera Shake')}
          >
            {t('inspector.cameraShake.off', 'Off')}
          </Button>
        )}
      </div>
    </TwirlGroup>
  );
}

export default CameraShakeRows;
