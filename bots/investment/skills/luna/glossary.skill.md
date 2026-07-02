---
name: luna-glossary
description: Define Luna operating terms such as regime, candidate, risk band, conviction, shadow, and promotion gate.
triggers:
  - luna glossary
  - investment terminology
  - explain luna terms
---

# Luna Glossary

- Owner: luna
- Category: reference
- Contract: Explain Luna operating vocabulary in plain language without changing runtime behavior.
- Safety: reference only; do not infer approvals, place orders, update parameters, or change launchd state.

## Core Terms
- Regime: current market state used for strategy routing, such as trending bull, trending bear, or ranging.
- Candidate: a symbol or setup under consideration before entry gates approve it.
- Risk band: bounded capital or sizing range used to avoid overexposure.
- Conviction: directional confidence signal, normally advisory unless an explicit gate enables it.
- Shadow: observe, log, or simulate without live mutation.
- Promotion gate: evidence checklist that must pass before master review or activation.
