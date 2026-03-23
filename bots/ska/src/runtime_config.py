import json
import os
from copy import deepcopy

DEFAULT_RUNTIME_CONFIG = {
    "forecast": {
        "conditionAdjustmentWeight": 0.50,
        "reservationAdjustmentWeight": 0.55,
        "calibrationMaxRatio": 0.22,
        "bookedHoursAdjustmentWeight": 0.40,
        "roomSpreadAdjustmentWeight": 0.24,
        "peakOverlapAdjustmentWeight": 0.22,
        "morningPatternAdjustmentWeight": 0.08,
        "afternoonPatternAdjustmentWeight": 0.12,
        "eveningPatternAdjustmentWeight": 0.18,
        "reservationTrendAdjustmentWeight": 0.24,
        "bookedHoursTrendAdjustmentWeight": 0.22,
        "shadowModelEnabled": True,
        "shadowModelName": "knn-shadow-v1",
        "shadowNeighborCount": 7,
        "shadowMinimumTrainRows": 21,
        "shadowPromotionMapeGap": 2.0,
        "sarimaPeriods": 7,
        "sarimaMaxIter": 200,
        "perModelAccuracyDays": 30,
        "minimumModelWeight": 0.10,
        "llmDiagnosisRagThreshold": 0.60,
        "monthlyReviewGradeGood": 12,
        "monthlyReviewGradeWarn": 22,
        "weekdayBiasAlertAmount": 20000,
    },
    "rebecca": {
        "weeklyGradeGood": 10,
        "weeklyGradeWarn": 20,
        "anomalyRagThreshold": 0.55,
    },
}

_cached_config = None


def _deep_merge(base, override):
    result = deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_runtime_config():
    global _cached_config
    if _cached_config is not None:
        return _cached_config

    config_path = os.path.join(os.path.dirname(__file__), '..', 'config.json')
    try:
        with open(config_path, 'r', encoding='utf-8') as fp:
            raw = json.load(fp)
        _cached_config = _deep_merge(DEFAULT_RUNTIME_CONFIG, raw.get('runtime_config') or {})
    except Exception:
        _cached_config = deepcopy(DEFAULT_RUNTIME_CONFIG)
    return _cached_config


def get_forecast_config():
    return load_runtime_config()["forecast"]


def get_rebecca_config():
    return load_runtime_config()["rebecca"]
