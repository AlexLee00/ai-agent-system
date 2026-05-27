#!/usr/bin/env python3
"""Prepare Luna PPO shadow training data.

The script is intentionally read-only by default. It uses live database rows
only when a PostgreSQL driver and DATABASE_URL are available; otherwise it
returns deterministic fixture data so CI and launchd smoke checks stay stable.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple

from luna_trading_env import FEATURE_NAMES, fixture_sample


def clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def number(row: Dict[str, Any], *names: str, default: float = 0.0) -> float:
    for name in names:
        value = row.get(name)
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return default


def text(row: Dict[str, Any], *names: str, default: str = "") -> str:
    for name in names:
        value = row.get(name)
        if value is not None and str(value).strip():
            return str(value).strip()
    return default


def normalize_return(value: float) -> float:
    if abs(value) > 1.0:
        value = value / 100.0
    return clamp(value, -1.0, 1.0)


def row_to_sample(row: Dict[str, Any]) -> Dict[str, Any]:
    entry_price = number(row, "entry_price", "avg_entry_price", "buy_price", "open_price", default=0.0)
    exit_price = number(row, "exit_price", "avg_exit_price", "sell_price", "close_price", default=0.0)
    pnl_pct = number(row, "realized_pnl_pct", "pnl_pct", "pnl_percent", "return_pct", default=0.0)
    if pnl_pct == 0.0 and entry_price > 0 and exit_price > 0:
        pnl_pct = ((exit_price - entry_price) / entry_price) * 100.0
    next_return = normalize_return(pnl_pct)
    action = 1.0 if next_return > 0.006 else -1.0 if next_return < -0.006 else 0.0

    features = {
        "momentum5": clamp(number(row, "momentum5", "momentum_5", default=next_return * 8.0)),
        "momentum20": clamp(number(row, "momentum20", "momentum_20", default=next_return * 4.0)),
        "volatility20": clamp(abs(number(row, "volatility20", "volatility_20", default=0.18)), 0.0, 1.0),
        "drawdown20": clamp(abs(number(row, "drawdown20", "drawdown_20", default=max(0.0, -next_return))), 0.0, 1.0),
        "factorComposite": clamp(number(row, "factor_composite", "factorComposite", default=0.5 + next_return)),
        "statArbConfidence": clamp(number(row, "stat_arb_confidence", "statArbConfidence", default=0.35), 0.0, 1.0),
        "entryConfidence": clamp(number(row, "entry_confidence", "entryConfidence", default=0.5 + abs(next_return)), 0.0, 1.0),
        "regimeConfidence": clamp(number(row, "regime_confidence", "regimeConfidence", default=0.55), 0.0, 1.0),
        "cashPct": clamp(number(row, "cash_pct", "cashPct", default=1.0), 0.0, 1.0),
        "positionPct": clamp(number(row, "position_pct", "positionPct", default=0.0), -1.0, 1.0),
        "unrealizedPnlPct": clamp(normalize_return(number(row, "unrealized_pnl_pct", "unrealizedPnlPct", default=0.0))),
        "riskBudgetPct": clamp(number(row, "risk_budget_pct", "riskBudgetPct", default=0.02), 0.0, 1.0),
    }

    return {
        "symbol": text(row, "symbol", "ticker", default="UNKNOWN"),
        "market": text(row, "market", "exchange", default="unknown"),
        "opened_at": text(row, "opened_at", "entry_time", "created_at", default=""),
        "closed_at": text(row, "closed_at", "exit_time", "updated_at", "created_at", default=""),
        "entry_price": entry_price,
        "exit_price": exit_price,
        "features": {name: float(features.get(name, 0.0)) for name in FEATURE_NAMES},
        "action": action,
        "reward": float(next_return),
        "next_return": float(next_return),
    }


def fixture_samples() -> List[Dict[str, Any]]:
    base = fixture_sample()
    samples = []
    returns = [0.012, -0.007, 0.004, 0.018, -0.014, 0.006, 0.0, 0.009]
    for idx, ret in enumerate(returns):
        sample = json.loads(json.dumps(base))
        sample.update(
            {
                "symbol": f"FIXTURE{idx + 1}/USDT",
                "market": "fixture",
                "opened_at": f"2026-01-{idx + 1:02d}T00:00:00Z",
                "closed_at": f"2026-01-{idx + 1:02d}T01:00:00Z",
                "entry_price": 100.0,
                "exit_price": 100.0 * (1.0 + ret),
                "action": 1.0 if ret > 0.006 else -1.0 if ret < -0.006 else 0.0,
                "reward": ret,
                "next_return": ret,
            }
        )
        sample["features"]["momentum5"] = clamp(ret * 8.0)
        sample["features"]["momentum20"] = clamp(ret * 4.0)
        sample["features"]["drawdown20"] = max(0.0, -ret)
        samples.append(sample)
    return samples


def import_pg_driver():
    try:
        import psycopg  # type: ignore

        return "psycopg", psycopg
    except Exception:
        try:
            import psycopg2  # type: ignore
            from psycopg2.extras import RealDictCursor  # type: ignore

            return "psycopg2", (psycopg2, RealDictCursor)
        except Exception:
            return None, None


def fetch_trade_rows_via_node(limit: int) -> Tuple[List[Dict[str, Any]], str]:
    project_root = Path(__file__).resolve().parents[4]
    script = """
      import { query } from './bots/investment/shared/db.ts';
      const limit = Math.max(1, Number(process.argv[1] || 500));
      try {
        const rows = await query(`
          SELECT *
          FROM investment.trade_journal
          WHERE COALESCE(exclude_from_learning, false) = false
            AND status <> 'open'
          ORDER BY COALESCE(exit_time, created_at, entry_time) DESC
          LIMIT $1
        `, [limit]);
        console.log(JSON.stringify({ ok: true, rows }));
      } catch (error) {
        console.log(JSON.stringify({ ok: false, error: error?.message || String(error) }));
      }
    """
    try:
      completed = subprocess.run(
          ["node", "--input-type=module", "-e", script, str(limit)],
          cwd=str(project_root),
          text=True,
          capture_output=True,
          timeout=20,
          check=False,
      )
      payload = json.loads(completed.stdout or "{}")
      if completed.returncode == 0 and payload.get("ok"):
          return [dict(row) for row in payload.get("rows", [])], "database_node"
      detail = payload.get("error") or completed.stderr.strip().splitlines()[0][:180] or f"node_exit_{completed.returncode}"
      return [], f"node_database_unavailable:{detail}"
    except Exception as exc:
      return [], f"node_database_unavailable:{type(exc).__name__}"


def fetch_trade_rows(limit: int) -> Tuple[List[Dict[str, Any]], str]:
    db_url = os.environ.get("DATABASE_URL", "").strip()
    if not db_url:
        return fetch_trade_rows_via_node(limit)

    driver, module = import_pg_driver()
    if not driver:
        return [], "missing_postgres_driver"

    try:
        if driver == "psycopg":
            with module.connect(db_url, connect_timeout=5, row_factory=module.rows.dict_row) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT *
                        FROM investment.trade_journal
                        WHERE COALESCE(exclude_from_learning, false) = false
                          AND status <> 'open'
                        ORDER BY COALESCE(exit_time, created_at, entry_time) DESC
                        LIMIT %s
                        """,
                        (limit,),
                    )
                    return [dict(row) for row in cur.fetchall()], "database"
        psycopg2, real_dict_cursor = module
        with psycopg2.connect(db_url, connect_timeout=5) as conn:
            with conn.cursor(cursor_factory=real_dict_cursor) as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM investment.trade_journal
                    WHERE COALESCE(exclude_from_learning, false) = false
                      AND status <> 'open'
                    ORDER BY COALESCE(exit_time, created_at, entry_time) DESC
                    LIMIT %s
                    """,
                    (limit,),
                )
                return [dict(row) for row in cur.fetchall()], "database"
    except Exception as exc:
        return [], f"database_unavailable:{type(exc).__name__}"


def split_samples(samples: Sequence[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    ordered = sorted(samples, key=lambda sample: sample.get("closed_at") or sample.get("opened_at") or "")
    if len(ordered) <= 1:
        return list(ordered), []
    split_at = max(1, int(len(ordered) * 0.8))
    return list(ordered[:split_at]), list(ordered[split_at:])


def build_payload(args: argparse.Namespace) -> Dict[str, Any]:
    if args.fixture:
        rows: List[Dict[str, Any]] = []
        source = "fixture_forced"
    else:
        rows, source = fetch_trade_rows(args.limit)

    samples = [row_to_sample(row) for row in rows if text(row, "symbol", "ticker", default="")]
    if not samples:
        samples = fixture_samples()
        if source == "fixture_forced":
            source = "fixture_forced"
        elif source == "missing_DATABASE_URL":
            source = "fixture"
        else:
            source = f"fixture_after_{source}"

    train, validation = split_samples(samples)
    avg_reward = sum(sample["reward"] for sample in samples) / max(1, len(samples))
    payload = {
        "ok": True,
        "shadow_only": True,
        "source": source,
        "feature_names": FEATURE_NAMES,
        "samples": len(samples),
        "train_samples": len(train),
        "validation_samples": len(validation),
        "avg_reward": round(avg_reward, 6),
        "train": train,
        "validation": validation,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    if args.write:
        out_dir = Path(args.output_dir).expanduser().resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / "luna_ppo_training_data.json"
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        payload["output_path"] = str(target)
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--fixture", action="store_true")
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--output-dir", default=str(Path(__file__).resolve().parent / "data"))
    args = parser.parse_args()

    payload = build_payload(args)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    else:
        print(
            f"[luna-rl-data] source={payload['source']} samples={payload['samples']} "
            f"train={payload['train_samples']} validation={payload['validation_samples']}"
        )


if __name__ == "__main__":
    main()
