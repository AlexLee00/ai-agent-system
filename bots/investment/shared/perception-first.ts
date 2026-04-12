// @ts-nocheck
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PERCEPTION_FIRST = {
  enabled: false,
  fear_greed_extreme_high: 85,
  fear_greed_extreme_low: 15,
  volume_ratio_floor: 0.30,
  consecutive_loss_cooldown: 3,
  skip_reasons: {
    fear_greed_extreme: true,
    volume_dry_up: true,
    consecutive_losses: true,
  },
};

function loadPerceptionFirstConfig() {
  try {
    const raw = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
    return raw?.perception_first || {};
  } catch {
    return {};
  }
}

export function getPerceptionFirstConfig() {
  const config = loadPerceptionFirstConfig();
  return {
    enabled: config.enabled === true,
    fear_greed_extreme_high: Number(config.fear_greed_extreme_high ?? DEFAULT_PERCEPTION_FIRST.fear_greed_extreme_high),
    fear_greed_extreme_low: Number(config.fear_greed_extreme_low ?? DEFAULT_PERCEPTION_FIRST.fear_greed_extreme_low),
    volume_ratio_floor: Number(config.volume_ratio_floor ?? DEFAULT_PERCEPTION_FIRST.volume_ratio_floor),
    consecutive_loss_cooldown: Number(config.consecutive_loss_cooldown ?? DEFAULT_PERCEPTION_FIRST.consecutive_loss_cooldown),
    skip_reasons: {
      fear_greed_extreme:
        config.skip_reasons?.fear_greed_extreme ?? DEFAULT_PERCEPTION_FIRST.skip_reasons.fear_greed_extreme,
      volume_dry_up:
        config.skip_reasons?.volume_dry_up ?? DEFAULT_PERCEPTION_FIRST.skip_reasons.volume_dry_up,
      consecutive_losses:
        config.skip_reasons?.consecutive_losses ?? DEFAULT_PERCEPTION_FIRST.skip_reasons.consecutive_losses,
    },
  };
}

export function shouldAnalyzeWithPerception({
  fearGreed = null,
  volumeRatio = null,
  consecutiveLosses = 0,
  enabled = null,
} = {}) {
  const config = getPerceptionFirstConfig();
  const featureEnabled = enabled === null ? config.enabled : enabled === true;

  if (!featureEnabled) {
    return {
      shouldAnalyze: true,
      reason: 'perception_first_disabled',
      signals: [],
    };
  }

  const signals = [];
  const numericFg =
    fearGreed === null || fearGreed === undefined || fearGreed === ''
      ? Number.NaN
      : Number(fearGreed);
  const numericVolumeRatio =
    volumeRatio === null || volumeRatio === undefined || volumeRatio === ''
      ? Number.NaN
      : Number(volumeRatio);
  const numericLosses = Number(consecutiveLosses);

  if (
    config.skip_reasons.fear_greed_extreme &&
    Number.isFinite(numericFg) &&
    (numericFg >= config.fear_greed_extreme_high || numericFg <= config.fear_greed_extreme_low)
  ) {
    signals.push({
      type: 'fear_greed_extreme',
      reason: `fear_greed ${numericFg} outside ${config.fear_greed_extreme_low}-${config.fear_greed_extreme_high}`,
    });
  }

  if (
    config.skip_reasons.volume_dry_up &&
    Number.isFinite(numericVolumeRatio) &&
    numericVolumeRatio < config.volume_ratio_floor
  ) {
    signals.push({
      type: 'volume_dry_up',
      reason: `volume_ratio ${numericVolumeRatio.toFixed(2)} below ${config.volume_ratio_floor}`,
    });
  }

  if (
    config.skip_reasons.consecutive_losses &&
    Number.isFinite(numericLosses) &&
    numericLosses >= config.consecutive_loss_cooldown
  ) {
    signals.push({
      type: 'consecutive_losses',
      reason: `consecutive_losses ${numericLosses} >= ${config.consecutive_loss_cooldown}`,
    });
  }

  if (signals.length > 0) {
    return {
      shouldAnalyze: false,
      reason: signals[0].type,
      signals,
    };
  }

  return {
    shouldAnalyze: true,
    reason: 'allowed',
    signals: [],
  };
}
