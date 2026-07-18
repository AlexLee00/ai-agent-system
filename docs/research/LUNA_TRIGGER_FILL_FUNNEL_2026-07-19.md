# Luna Trigger-to-Fill Funnel, 2026-07-16 to 2026-07-18

## Finding

Bounded read-only database queries and scheduler-log inspection show that all
four requested trigger cases reached Binance fills. ADA was the only position
still open at review time, not the only filled case. Candidate rows are
transient, so candidate-stage values come from the persisted trigger context;
entry order IDs and exact pre-order free USDT were not retained.

| Case | Candidate context | Trigger and guards | Rationale / sizing | Fill and journal |
|---|---|---|---|---|
| ETH/USDT, 2026-07-16 22:52 KST | discovery 0.4604; predictive 0.4782; volume 0.2794; `trending_bear -> defensive_rotation` | trigger `ed46c69e-2378-4db6-821f-1c4a07fbf56b`; signal `ecee866e-4dfc-49d3-b169-10841267badd`; fired 22:51:26.251; live risk passed; overbought-chase guard was advisory | Nemesis changed $28 to $41.31; live sizer submitted about $99.061 | 0.0526 ETH at 1,883.29, 22:52:13.038; journal `3554fa12-9a07-4cd4-8316-f62460de4fe4`; `TRD-20260716-003`; later closed |
| BTC/USDT, 2026-07-17 15:09 KST | discovery 0.4359; predictive 0.4647; volume 0.0378; `trending_bear -> defensive_rotation` | trigger `84184ef0-2750-4336-8bde-ec9eefae1512`; signal `69768cff-6dbf-4ce8-8cb7-e2edbdae29bf`; fired 15:08:28.632; TradingView daily-trend guard was advisory | Nemesis changed $28 to $41.24; live sizer submitted about $98.765 | 0.00157 BTC at 62,907.9, 15:09:14.139; journal `178d5dbd-151d-4a96-9074-59ed19cf86f3`; `TRD-20260717-001`; later closed |
| ADA/USDT, 2026-07-18 09:26 KST | discovery 0.5144; predictive 0.5079; volume 1.94; news 0.2645; `trending_bear -> defensive_rotation` | trigger `9961f0dc-ace4-4c8e-9185-2db8a5cebe42`; signal `24f6eaf9-85b6-4019-b3ff-b1a50a416b90`; fired 09:25:39.981; TradingView daily-trend guard was advisory | Nemesis changed $28 to $41.33; live sizer submitted about $99.191 | 593.6 ADA at 0.1671, 09:26:30.464; journal `d5045d40-4bd6-4646-aeaf-a385c6b12373`; `TRD-20260718-001`; still open at review time |
| ZEC/USDT, 2026-07-18 10:00 KST | discovery 0.4178; predictive 0.4548; volume 0.7765; `trending_bear -> defensive_rotation` | trigger `6131d6e2-0c3f-42b6-9520-6c6177537434`; signal `4dc7be74-aa33-4651-9e53-c7fa3714cad2`; fired 09:59:08.953; defensive-rotation evidence guard was advisory | guard reduced $36.37 to $9.0925 at 0.25x, but the later live sizer submitted about $98.975 | 0.181 ZEC at 546.822, 09:59:57.684; journal `3c1d02b9-d833-49d3-a950-fda1887b042b`; `TRD-20260718-002`; later closed |

## Evidence and Follow-Up

Fill lines are present in `/tmp/ai.luna.ops-scheduler.out.log` at lines 521468,
623598, 733977, and 737201. The funnel persists candidate-to-trigger context in
`entry-trigger-engine.ts`, submits at `signal-executor.ts`, and records the
resulting trade journal asynchronously; cleanup later reconstructed three closed
rows.

The ZEC trace exposes a separate sizing-order risk: an execution guard can reduce
the requested amount before a later live-capital sizing step replaces it. This
review does not change live trading behavior. Open a separate shadow-first task
to make guard reductions authoritative through final order sizing and add a
counterfactual regression test.
