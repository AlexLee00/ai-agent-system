#!/usr/bin/env python3
"""KIS MCP input-boundary regression smoke. No external API calls."""

from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SERVER_PATH = Path(__file__).with_name("kis-market-mcp-server.py")
SPEC = importlib.util.spec_from_file_location("kis_market_mcp_server", SERVER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("failed to load KIS MCP server module")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class KisMcpSecuritySmoke(unittest.TestCase):
    def test_rejects_unknown_action_before_subprocess(self):
        with patch.object(SERVER.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "unsupported bridge action"):
                SERVER.run_node_kis_bridge("run_arbitrary_code", {})
        run.assert_not_called()

    def test_rejects_non_object_payload_before_subprocess(self):
        with patch.object(SERVER.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "payload must be an object"):
                SERVER.run_node_kis_bridge("quote", [])
        run.assert_not_called()

    def test_rejects_invalid_market_symbol_and_oversized_payload(self):
        invalid_requests = [
            ("quote", {"market": "crypto", "symbol": "005930"}),
            ("domestic_quote", {"symbol": "005930;process.exit(0)"}),
            ("domestic_quote", {"symbol": " 005930"}),
            ("overseas_quote", {"symbol": "AAPL\nINJECT"}),
            ("quote", {"market": "domestic", "symbol": "005930", "extra": "x"}),
            ("quote", {"market": "domestic", "symbol": "005930", "padding": "x" * 40_000}),
            ("domestic_buy", {"symbol": "005930", "amountKrw": float("nan"), "dryRun": True}),
        ]

        for action, payload in invalid_requests:
            with self.subTest(action=action, payload_keys=list(payload)):
                with patch.object(SERVER.subprocess, "run") as run:
                    with self.assertRaises(ValueError):
                        SERVER.run_node_kis_bridge(action, payload)
                run.assert_not_called()

    def test_rejects_invalid_order_and_ranking_inputs(self):
        invalid_requests = [
            ("domestic_buy", {"symbol": "005930", "amountKrw": -1, "dryRun": True, "paper": True}),
            ("domestic_sell", {"symbol": "005930", "qty": 1.5, "dryRun": True, "paper": True}),
            ("domestic_fill", {"symbol": "005930", "ordNo": "1 OR 1=1", "side": "all"}),
            (
                "domestic_ranking",
                {"endpoint": "/uapi/domestic-stock/v1/../trading/order", "trId": "FHPST01710000", "params": {}},
            ),
            (
                "domestic_ranking",
                {"endpoint": "/uapi/domestic-stock/v1/ranking/volume", "trId": "bad-id!", "params": {}},
            ),
        ]

        for action, payload in invalid_requests:
            with self.subTest(action=action):
                with patch.object(SERVER.subprocess, "run") as run:
                    with self.assertRaises(ValueError):
                        SERVER.run_node_kis_bridge(action, payload)
                run.assert_not_called()

    def test_passes_validated_payload_via_stdin_not_generated_source(self):
        marker = "AAPLINJECTION"
        captured = {}

        def fake_run(args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            return SimpleNamespace(returncode=0, stdout='{"status":"ok"}\n', stderr="")

        payload = {"market": "overseas", "symbol": marker, "paper": False}
        with patch.object(SERVER.subprocess, "run", side_effect=fake_run):
            result = SERVER.run_node_kis_bridge("quote", payload)

        self.assertEqual(result, {"status": "ok"})
        self.assertNotIn(marker, captured["args"][-1])
        envelope = json.loads(captured["kwargs"]["input"])
        self.assertEqual(envelope, {"action": "quote", "payload": payload})
        self.assertGreater(captured["kwargs"]["timeout"], 0)

    def test_redacts_static_runner_from_timeout_error(self):
        timeout = SERVER.subprocess.TimeoutExpired(cmd=["node", "sensitive-static-runner"], timeout=30)
        with patch.object(SERVER.subprocess, "run", side_effect=timeout):
            with self.assertRaisesRegex(RuntimeError, "KIS bridge timed out") as caught:
                SERVER.run_node_kis_bridge("quote", {"market": "domestic", "symbol": "005930"})
        self.assertNotIn("sensitive-static-runner", str(caught.exception))

    def test_accepts_current_read_and_dry_run_order_contracts(self):
        valid_requests = [
            ("health", {"paper": True, "domesticSymbol": "005930", "overseasSymbol": "AAPL"}),
            ("quote", {"market": "domestic", "symbol": "005930", "paper": False}),
            ("domestic_fill", {"symbol": "005930", "ordNo": "1234567890", "side": "BUY", "paper": True}),
            ("domestic_buy", {"symbol": "005930", "amountKrw": 10_000, "dryRun": True, "paper": True}),
            (
                "domestic_ranking",
                {
                    "endpoint": "/uapi/domestic-stock/v1/ranking/volume",
                    "trId": "FHPST01710000",
                    "params": {"FID_INPUT_ISCD": "0000"},
                    "paper": False,
                },
            ),
        ]

        for action, payload in valid_requests:
            with self.subTest(action=action):
                self.assertEqual(SERVER.validate_bridge_request(action, payload), payload)


if __name__ == "__main__":
    unittest.main(verbosity=2)
