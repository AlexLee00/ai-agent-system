#!/usr/bin/env python3
"""Luna Phase 2 Stage 1 meta-label dry smoke.

DB/네트워크/거래소를 사용하지 않는 Return 배열 기반 순수 함수 검증이다.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
BACKTEST = ROOT / "bots" / "investment" / "scripts" / "backtest-vectorbt.py"


def load_backtest_module():
    spec = importlib.util.spec_from_file_location("luna_backtest_vectorbt", BACKTEST)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def assert_equal(name: str, actual, expected):
    if actual != expected:
        raise AssertionError(f"{name}: expected={expected!r} actual={actual!r}")


def main() -> int:
    mod = load_backtest_module()

    case_a = mod.compute_meta_label_distribution_from_returns([0.10, -0.20, 0.0, 0.001, -0.001], method="A", neutral_eps=0.0)
    assert_equal("case_a.status", case_a["meta_label_status"], "ok")
    assert_equal("case_a.dist", case_a["meta_label_dist"], {
        "pos": 2,
        "neg": 2,
        "neutral": 1,
        "total": 5,
        "pos_rate": 0.4,
    })

    case_b = mod.compute_meta_label_distribution_from_returns([0.02, -0.02, 0.01, -0.01, 0.0], method="A", neutral_eps=0.01)
    assert_equal("case_b.dist", case_b["meta_label_dist"], {
        "pos": 1,
        "neg": 1,
        "neutral": 3,
        "total": 5,
        "pos_rate": 0.2,
    })

    case_c = mod.compute_meta_label_distribution_from_returns([], method="A", neutral_eps=0.0)
    assert_equal("case_c.dist", case_c["meta_label_dist"], None)
    assert_equal("case_c.status", case_c["meta_label_status"], "insufficient")
    if not case_c["meta_label_reasons"]:
        raise AssertionError("case_c reasons empty")

    case_d1 = mod.compute_meta_label_distribution_from_returns([0.03, -0.04, 0.0], method="A", neutral_eps=0.0)
    case_d2 = mod.compute_meta_label_distribution_from_returns([0.03, -0.04, 0.0], method="A", neutral_eps=0.0)
    assert_equal("case_d.reproducible", case_d1, case_d2)

    case_e = mod.compute_meta_label_distribution_from_returns([0.01], method="B", neutral_eps=0.0)
    assert_equal("case_e.unsupported", case_e["meta_label_dist"], None)
    if not case_e["meta_label_reasons"]:
        raise AssertionError("case_e reasons empty")

    print(json.dumps({
        "ok": True,
        "case_a": case_a,
        "case_b": case_b,
        "case_c": case_c,
        "case_d_reproducible": True,
        "case_e": case_e,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

