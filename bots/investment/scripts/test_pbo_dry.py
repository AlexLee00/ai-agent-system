#!/usr/bin/env python3
"""
PBO/CSCV dry 테스트 — 케이스 A~D (DB/네트워크 없음, 순수 함수 검증)
"""
import math
import sys
import os
import random

sys.path.insert(0, os.path.dirname(__file__))

try:
    import numpy as _np
except ImportError:
    print("SKIP: numpy 없음")
    sys.exit(0)

# backtest-vectorbt.py — 하이픈 포함 파일명, importlib으로 로딩
import importlib.util
_spec = importlib.util.spec_from_file_location(
    "backtest_vectorbt",
    os.path.join(os.path.dirname(__file__), "backtest-vectorbt.py"),
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
compute_pbo_from_returns_matrix = _mod.compute_pbo_from_returns_matrix
_pbo_none = _mod._pbo_none
run_backtest = _mod.run_backtest

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
results = []


def check(name: str, cond: bool, detail: str = ""):
    tag = PASS if cond else FAIL
    msg = f"[{tag}] {name}"
    if detail:
        msg += f" — {detail}"
    print(msg)
    results.append(cond)


# ────────────────────────────────────────────────────────────────────────────
# 케이스 A: 랜덤 무신호 N=20 trial, T 충분 → PBO ≈ 0.5 (0.35~0.65 허용)
# ────────────────────────────────────────────────────────────────────────────
print("\n=== 케이스 A: 랜덤 무신호 N=20 ===")
random.seed(42)
N, T = 20, 320
matrix_a = [[random.gauss(0, 0.01) for _ in range(N)] for _ in range(T)]
res_a = compute_pbo_from_returns_matrix(matrix_a, n_blocks=16, min_trials=10)
print(f"  pbo={res_a['pbo']}, status={res_a['pbo_status']}, n_combinations={res_a['pbo_n_combinations']}")
check("케이스A pbo_status=ok", res_a["pbo_status"] == "ok")
check("케이스A pbo∈[0,1]", res_a["pbo"] is not None and 0.0 <= res_a["pbo"] <= 1.0,
      f"pbo={res_a['pbo']}")
check("케이스A pbo≈0.5 (0.35~0.65)", res_a["pbo"] is not None and 0.35 <= res_a["pbo"] <= 0.65,
      f"pbo={res_a['pbo']:.4f}")
check("케이스A n_combinations=C(16,8)=12870",
      res_a["pbo_n_combinations"] == 12870,
      f"n_combinations={res_a['pbo_n_combinations']}")

# ────────────────────────────────────────────────────────────────────────────
# 케이스 B: trial 0에 일관 우월 신호 → PBO 낮음(<0.3) + dominance_first_order True
# ────────────────────────────────────────────────────────────────────────────
print("\n=== 케이스 B: trial 0 일관 우월 ===")
random.seed(77)
N2, T2 = 15, 320
matrix_b = [[random.gauss(0, 0.01) for _ in range(N2)] for _ in range(T2)]
# trial 0: 강한 양수 수익
for row in matrix_b:
    row[0] = random.gauss(0.005, 0.003)
res_b = compute_pbo_from_returns_matrix(matrix_b, n_blocks=16, min_trials=10)
print(f"  pbo={res_b['pbo']:.4f}, dominance_first_order={res_b['dominance_first_order']}, "
      f"perf_degradation={res_b['perf_degradation']}, prob_loss={res_b['prob_loss']:.4f}")
check("케이스B pbo_status=ok", res_b["pbo_status"] == "ok")
check("케이스B pbo<0.3 (우월 trial)", res_b["pbo"] is not None and res_b["pbo"] < 0.3,
      f"pbo={res_b['pbo']:.4f}")
check("케이스B dominance_first_order=True", res_b["dominance_first_order"] is True,
      f"dominance={res_b['dominance_first_order']}")

# ────────────────────────────────────────────────────────────────────────────
# 케이스 C: T < n_blocks → pbo=None + pbo_reasons 비어있지 않음 (예외 아님)
# ────────────────────────────────────────────────────────────────────────────
print("\n=== 케이스 C: T < n_blocks (insufficient) ===")
matrix_c_short = [[0.0] * 20] * 8  # T=8 < n_blocks=16
res_c1 = compute_pbo_from_returns_matrix(matrix_c_short, n_blocks=16, min_trials=10)
print(f"  T<n_blocks: pbo={res_c1['pbo']}, status={res_c1['pbo_status']}, reasons={res_c1['pbo_reasons']}")
check("케이스C T<n_blocks pbo=None", res_c1["pbo"] is None)
check("케이스C T<n_blocks pbo_status=insufficient", res_c1["pbo_status"] == "insufficient")
check("케이스C T<n_blocks pbo_reasons 비어있지 않음", len(res_c1["pbo_reasons"]) > 0)

matrix_c_few = [[0.0] * 5] * 320  # N=5 < min_trials=10
res_c2 = compute_pbo_from_returns_matrix(matrix_c_few, n_blocks=16, min_trials=10)
print(f"  N<min_trials: pbo={res_c2['pbo']}, status={res_c2['pbo_status']}, reasons={res_c2['pbo_reasons']}")
check("케이스C N<min_trials pbo=None", res_c2["pbo"] is None)
check("케이스C N<min_trials pbo_reasons 비어있지 않음", len(res_c2["pbo_reasons"]) > 0)

# ────────────────────────────────────────────────────────────────────────────
# 케이스 D: 재현성 — 동일 입력 2회 동일 PBO
# ────────────────────────────────────────────────────────────────────────────
print("\n=== 케이스 D: 재현성 ===")
random.seed(99)
matrix_d = [[random.gauss(0, 0.01) for _ in range(18)] for _ in range(256)]
res_d1 = compute_pbo_from_returns_matrix(matrix_d, n_blocks=16, min_trials=10)
res_d2 = compute_pbo_from_returns_matrix(matrix_d, n_blocks=16, min_trials=10)
print(f"  1st pbo={res_d1['pbo']}, 2nd pbo={res_d2['pbo']}")
check("케이스D 재현성 (pbo 동일)", res_d1["pbo"] == res_d2["pbo"],
      f"{res_d1['pbo']} == {res_d2['pbo']}")
check("케이스D n_combinations 동일",
      res_d1["pbo_n_combinations"] == res_d2["pbo_n_combinations"])

# ────────────────────────────────────────────────────────────────────────────
# 추가: collect_returns 플래그 기존 호출 호환성
# ────────────────────────────────────────────────────────────────────────────
print("\n=== collect_returns 기본값(False) 영향 없음 체크 ===")
import inspect
sig = inspect.signature(run_backtest)
params = sig.parameters
check("run_backtest collect_returns 기본값=False",
      "collect_returns" in params and params["collect_returns"].default is False)

# ────────────────────────────────────────────────────────────────────────────
# 결과 요약
# ────────────────────────────────────────────────────────────────────────────
total = len(results)
passed = sum(results)
print(f"\n결과: {passed}/{total} 통과")
sys.exit(0 if passed == total else 1)
