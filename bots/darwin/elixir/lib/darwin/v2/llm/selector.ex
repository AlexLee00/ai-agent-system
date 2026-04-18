defmodule Darwin.V2.LLM.Selector do
  @moduledoc """
  다윈 LLM Selector — 공용 레이어 위임.

  Jay.Core.LLM.Selector를 사용하며 Darwin.V2.LLM.Policy로 팀 정책 주입.
  Kill switch: Darwin.V2.Config.kill_switch?() (Policy 콜백 경유).

  공개 API:
    complete/3           — (agent_name, messages, opts) → {:ok, content} | {:error, reason}
    call_with_fallback/3 — 구버전 호환 래퍼
    policy_for/1         — 에이전트 정적 정책 조회
  """

  use Jay.Core.LLM.Selector, policy_module: Darwin.V2.LLM.Policy
end
