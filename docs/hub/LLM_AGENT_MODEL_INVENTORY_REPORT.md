# LLM Agent Model Inventory

Generated at: 2026-05-12T12:05:38.115Z

## Summary
- Selector route targets: 156
- Active visible agents: 74
- Active runtime services: 9
- Task routes: 43
- Alias routes: 30
- Planned rows: 4
- Pending runtime rows: 11

## Primary Providers
```json
{
  "gemini-cli-oauth": 88,
  "openai-oauth": 19,
  "groq": 50
}
```

## Claude Code Routes
_없음_

## Missing Active Model Rows
_없음_

## Active Agent And Runtime Rows
| team | agent | kind | status | selector | primary | fallback | model_status |
|---|---|---|---|---|---|---|---|
| blog | blo | visible_agent | selected | blog._default | gemini-cli-oauth/gemini-2.5-flash | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| blog | gems | visible_agent | selected | blog.gems.writer | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4<br>groq/qwen/qwen3-32b | selector_chain |
| blog | pos | visible_agent | selected | blog.pos.writer | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4<br>groq/qwen/qwen3-32b | selector_chain |
| blog | publ | visible_agent | selected | blog._default | gemini-cli-oauth/gemini-2.5-flash | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| blog | richer | visible_agent | selected | blog._default | gemini-cli-oauth/gemini-2.5-flash | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| blog | star | visible_agent | selected | blog.star.summarize | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| claude | claude | team_container | ops |  |  |  | team_container |
| claude | archer | visible_agent | selected | claude.archer.tech_analysis | openai-oauth/gpt-5.4-mini | groq/qwen/qwen3-32b<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| claude | auto-dev | visible_agent | ops |  | openai-oauth/gpt-5.4 |  | auto_dev_implementation_model |
| claude | brian | visible_agent | ops |  |  |  | non_llm_role |
| claude | builder | visible_agent | selected | claude._default | openai-oauth/gpt-5.4 | groq/qwen/qwen3-32b<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| claude | commander | visible_agent | selected | claude.lead.system_issue_triage | openai-oauth/gpt-5.4 | groq/qwen/qwen3-32b<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| claude | dexter | visible_agent | selected | claude.dexter.ai_analyst | openai-oauth/gpt-5.4 | groq/qwen/qwen3-32b<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| claude | eric | visible_agent | ops |  |  |  | non_llm_role |
| claude | guardian | visible_agent | selected | claude.lead.system_issue_triage | openai-oauth/gpt-5.4 | groq/qwen/qwen3-32b<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| claude | kevin | visible_agent | ops |  |  |  | non_llm_role |
| claude | lead | visible_agent | selected | claude.lead.system_issue_triage | openai-oauth/gpt-5.4 | groq/qwen/qwen3-32b<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| claude | quality-report | visible_agent | selected | claude._default | openai-oauth/gpt-5.4 | groq/qwen/qwen3-32b<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| claude | reviewer | visible_agent | selected | claude._default | openai-oauth/gpt-5.4 | groq/qwen/qwen3-32b<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| darwin | commander | alias | selected | darwin.agent_policy | openai-oauth/gpt-5.4 | groq/qwen/qwen3-32b<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| darwin | evaluator | alias | selected | darwin.agent_policy | groq/qwen/qwen3-32b | gemini-cli-oauth/gemini-2.5-flash<br>openai-oauth/gpt-5.4-mini | selector_chain |
| darwin | planner | alias | selected | darwin.agent_policy | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4-mini | selector_chain |
| darwin | reflexion | alias | selected | darwin.agent_policy | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4-mini | selector_chain |
| darwin | scanner | alias | selected | darwin.agent_policy | gemini-cli-oauth/gemini-2.5-flash-lite |  | selector_chain |
| darwin | verifier | alias | selected | darwin.agent_policy | groq/qwen/qwen3-32b | gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| darwin | applier | visible_agent | selected | darwin.agent_policy | gemini-cli-oauth/gemini-2.5-flash-lite |  | selector_chain |
| darwin | darwin.commander | visible_agent | selected | darwin.agent_policy | openai-oauth/gpt-5.4 | groq/qwen/qwen3-32b | selector_chain |
| darwin | darwin.edison | visible_agent | selected | darwin.agent_policy | groq/qwen/qwen3-32b | gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| darwin | darwin.evaluator | visible_agent | selected | darwin.agent_policy | groq/qwen/qwen3-32b | gemini-cli-oauth/gemini-2.5-flash<br>openai-oauth/gpt-5.4-mini | selector_chain |
| darwin | darwin.planner | visible_agent | selected | darwin.agent_policy | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4-mini | selector_chain |
| darwin | darwin.reflexion | visible_agent | selected | darwin.agent_policy | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4-mini | selector_chain |
| darwin | darwin.scanner | visible_agent | selected | darwin.agent_policy | gemini-cli-oauth/gemini-2.5-flash-lite | groq/qwen/qwen3-32b | selector_chain |
| darwin | darwin.self_rewarding_judge | visible_agent | selected | darwin.agent_policy | gemini-cli-oauth/gemini-2.5-flash-lite | groq/qwen/qwen3-32b | selector_chain |
| darwin | darwin.verifier | visible_agent | selected | darwin.agent_policy | groq/qwen/qwen3-32b | gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| darwin | implementor | visible_agent | selected | darwin.agent_policy | groq/qwen/qwen3-32b | gemini-cli-oauth/gemini-2.5-flash<br>openai-oauth/gpt-5.4-mini | selector_chain |
| darwin | learner | visible_agent | selected | darwin.agent_policy | gemini-cli-oauth/gemini-2.5-flash-lite |  | selector_chain |
| hub | hub | visible_agent | ops |  |  |  | non_llm_service |
| investment | adaptive-risk | alias | selected | investment.adaptive-risk | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | analyst | alias | selected | investment.agent_policy | groq/llama-3.1-8b-instant | groq/openai/gpt-oss-20b<br>openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| investment | argos | alias | selected | investment.argos | groq/llama-3.1-8b-instant | groq/openai/gpt-oss-20b<br>openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| investment | aria | alias | selected | investment.aria | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4-mini<br>groq/llama-3.3-70b-versatile | selector_chain |
| investment | athena | alias | selected | investment.athena | groq/llama-3.1-8b-instant | groq/openai/gpt-oss-20b<br>openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| investment | budget | alias | selected | investment.budget | groq/llama-3.1-8b-instant | openai-oauth/gpt-5.4-mini | selector_chain |
| investment | chronos | alias | selected | investment.chronos | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | commander | alias | selected | investment.agent_policy | groq/llama-3.1-8b-instant | groq/openai/gpt-oss-20b<br>openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| investment | default | alias | selected | investment._default | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | hanul | alias | selected | investment.hanul | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | hephaestos | alias | selected | investment.hephaestos | groq/llama-3.1-8b-instant | openai-oauth/gpt-5.4-mini | selector_chain |
| investment | hermes | alias | selected | investment.hermes | groq/llama-3.1-8b-instant | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | kairos | alias | selected | investment.kairos | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4-mini<br>groq/llama-3.3-70b-versatile | selector_chain |
| investment | luna | alias | selected | investment.luna | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | nemesis | alias | selected | investment.nemesis | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | oracle | alias | selected | investment.oracle | groq/llama-3.1-8b-instant | groq/openai/gpt-oss-20b<br>openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| investment | reporter | alias | selected | investment.reporter | groq/llama-3.1-8b-instant | groq/openai/gpt-oss-20b<br>openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| investment | scout | alias | selected | investment.scout | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4-mini<br>groq/llama-3.3-70b-versatile | selector_chain |
| investment | sentinel | alias | selected | investment.sentinel | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| investment | sophia | alias | selected | investment.sophia | groq/llama-3.1-8b-instant | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | stock-flow | alias | selected | investment.stock-flow | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | sweeper | alias | selected | investment.sweeper | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| investment | validator | alias | selected | investment.agent_policy | groq/llama-3.1-8b-instant | groq/openai/gpt-oss-20b<br>openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| investment | zeus | alias | selected | investment.zeus | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | investment | team_container | live |  |  |  | team_container |
| investment | adaptive-risk | visible_agent | selected | investment.adaptive-risk | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | argos | visible_agent | selected | investment.argos | groq/llama-3.1-8b-instant | groq/openai/gpt-oss-20b<br>openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| investment | aria | visible_agent | selected | investment.aria | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4-mini<br>groq/llama-3.3-70b-versatile | selector_chain |
| investment | athena | visible_agent | selected | investment.athena | groq/llama-3.1-8b-instant | groq/openai/gpt-oss-20b<br>openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| investment | budget | visible_agent | selected | investment.budget | groq/llama-3.1-8b-instant | openai-oauth/gpt-5.4-mini | selector_chain |
| investment | chronos | visible_agent | selected | investment.chronos | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | hanul | visible_agent | selected | investment.hanul | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | hephaestos | visible_agent | selected | investment.hephaestos | groq/llama-3.1-8b-instant | openai-oauth/gpt-5.4-mini | selector_chain |
| investment | hermes | visible_agent | selected | investment.hermes | groq/llama-3.1-8b-instant | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | kairos | visible_agent | selected | investment.kairos | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4-mini<br>groq/llama-3.3-70b-versatile | selector_chain |
| investment | luna | visible_agent | selected | investment.luna | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | nemesis | visible_agent | selected | investment.nemesis | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | oracle | visible_agent | selected | investment.oracle | groq/llama-3.1-8b-instant | groq/openai/gpt-oss-20b<br>openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| investment | reporter | visible_agent | selected | investment.reporter | groq/llama-3.1-8b-instant | groq/openai/gpt-oss-20b<br>openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| investment | scout | visible_agent | selected | investment.scout | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4-mini<br>groq/llama-3.3-70b-versatile | selector_chain |
| investment | sentinel | visible_agent | selected | investment.sentinel | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| investment | sophia | visible_agent | selected | investment.sophia | groq/llama-3.1-8b-instant | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | stock-flow | visible_agent | selected | investment.stock-flow | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| investment | sweeper | visible_agent | selected | investment.sweeper | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| investment | zeus | visible_agent | selected | investment.zeus | groq/qwen/qwen3-32b | openai-oauth/gpt-5.4-mini<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| justin | analysis | visible_agent | selected | justin.analysis | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4 | selector_chain |
| justin | atlas | visible_agent | selected | justin.citation | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| justin | balance | visible_agent | selected | justin.opinion | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4<br>groq/qwen/qwen3-32b | selector_chain |
| justin | bench | visible_agent | selected | justin.opinion | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4<br>groq/qwen/qwen3-32b | selector_chain |
| justin | briefing | visible_agent | selected | justin.analysis | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4 | selector_chain |
| justin | chain | visible_agent | selected | justin.analysis | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4 | selector_chain |
| justin | citation | visible_agent | selected | justin.citation | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| justin | citecheck | visible_agent | selected | justin.citation | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| justin | claim | visible_agent | selected | justin.analysis | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4 | selector_chain |
| justin | contro | visible_agent | selected | justin.analysis | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4 | selector_chain |
| justin | default | visible_agent | selected | justin._default | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4<br>groq/qwen/qwen3-32b | selector_chain |
| justin | defense-x | visible_agent | selected | justin.analysis | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4 | selector_chain |
| justin | defense | visible_agent | selected | justin.analysis | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4 | selector_chain |
| justin | delta | visible_agent | selected | justin.analysis | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4 | selector_chain |
| justin | garam | visible_agent | selected | justin.citation | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| justin | justin | visible_agent | selected | justin.stage-3 | openai-oauth/gpt-5.4 | gemini-cli-oauth/gemini-2.5-flash<br>groq/qwen/qwen3-32b | selector_chain |
| justin | ledger-law | visible_agent | selected | justin.analysis | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4 | selector_chain |
| justin | lens | visible_agent | selected | justin.analysis | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4 | selector_chain |
| justin | neutral-bench | visible_agent | selected | justin.opinion | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4<br>groq/qwen/qwen3-32b | selector_chain |
| justin | opinion | visible_agent | selected | justin.opinion | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4<br>groq/qwen/qwen3-32b | selector_chain |
| justin | plaintiff-x | visible_agent | selected | justin.analysis | gemini-cli-oauth/gemini-2.5-flash | groq/qwen/qwen3-32b<br>openai-oauth/gpt-5.4 | selector_chain |
| justin | quill | visible_agent | selected | justin.opinion | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4<br>groq/qwen/qwen3-32b | selector_chain |
| justin | simple-qa | visible_agent | selected | justin.simple-qa | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| justin | stage-3 | visible_agent | selected | justin.stage-3 | openai-oauth/gpt-5.4 | gemini-cli-oauth/gemini-2.5-flash<br>groq/qwen/qwen3-32b | selector_chain |
| orchestrator | default | runtime_service | selected | orchestrator.jay.intent | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant | selector_chain |
| orchestrator | fallback | runtime_service | selected | orchestrator.jay.chat_fallback | groq/openai/gpt-oss-20b | gemini-cli-oauth/gemini-2.5-flash | selector_chain |
| orchestrator | intent | runtime_service | selected | orchestrator.jay.intent | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant | selector_chain |
| orchestrator | steward-digest | runtime_service | selected | orchestrator.steward.digest | gemini-cli-oauth/gemini-2.5-flash-lite |  | selector_chain |
| orchestrator | steward-incident | runtime_service | selected | orchestrator.steward.incident_plan | gemini-cli-oauth/gemini-2.5-flash | gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| orchestrator | steward-pro-canary | runtime_service | selected | orchestrator.steward.pro_canary | gemini-cli-oauth/gemini-2.5-flash | openai-oauth/gpt-5.4-mini | selector_chain |
| orchestrator | steward-work | runtime_service | selected | orchestrator.steward.work | gemini-cli-oauth/gemini-2.5-flash | gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| orchestrator | steward | runtime_service | selected | orchestrator.steward.work | gemini-cli-oauth/gemini-2.5-flash | gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| orchestrator | summary | runtime_service | selected | orchestrator.jay.summary | gemini-cli-oauth/gemini-2.5-flash | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| sigma | commander | visible_agent | selected | sigma.agent_policy | openai-oauth/gpt-5.4 | groq/qwen/qwen3-32b<br>gemini-cli-oauth/gemini-2.5-flash-lite | selector_chain |
| ska | andy | visible_agent | selected | ska.classify | groq/llama-3.1-8b-instant | gemini-cli-oauth/gemini-2.5-flash-lite<br>openai-oauth/gpt-5.4-mini | selector_chain |
| ska | eve | visible_agent | selected | ska._default | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |
| ska | jimmy | visible_agent | selected | ska.classify | groq/llama-3.1-8b-instant | gemini-cli-oauth/gemini-2.5-flash-lite<br>openai-oauth/gpt-5.4-mini | selector_chain |
| ska | rebecca | visible_agent | selected | ska._default | gemini-cli-oauth/gemini-2.5-flash-lite | groq/llama-3.1-8b-instant<br>openai-oauth/gpt-5.4-mini | selector_chain |

## Recommendations
- planned/pending_runtime teams must remain blocked until runtime source and selector ownership exist
- use LLM_CLAUDE_CODE_QUOTA_MODE=avoid or LLM_CLAUDE_CODE_DISABLED=true to shift legacy Claude Code usage to OpenAI OAuth during quota saturation
