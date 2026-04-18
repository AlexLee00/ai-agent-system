defmodule Jay.Core.LLM.Telemetry do
  @moduledoc """
  Jay.Core LLM 텔레메트리 — :telemetry 이벤트 발행.

  발행 이벤트:
    [:jay, :llm, :call, :start]   — LLM 호출 시작
    [:jay, :llm, :call, :stop]    — LLM 호출 완료 (성공/실패 포함)
    [:jay, :llm, :cache, :hit]    — Cache hit
    [:jay, :llm, :budget, :warn]  — 예산 경고
  """

  def span(event_prefix, meta, fun) do
    start_time = System.monotonic_time()
    :telemetry.execute(event_prefix ++ [:start], %{system_time: System.system_time()}, meta)

    try do
      result = fun.()
      duration = System.monotonic_time() - start_time
      :telemetry.execute(event_prefix ++ [:stop], %{duration: duration, system_time: System.system_time()}, Map.put(meta, :result, :ok))
      result
    rescue
      e ->
        duration = System.monotonic_time() - start_time
        :telemetry.execute(event_prefix ++ [:stop], %{duration: duration}, Map.merge(meta, %{result: :error, error: e}))
        reraise e, __STACKTRACE__
    end
  end

  def emit_call_start(agent_name, model, team) do
    :telemetry.execute([:jay, :llm, :call, :start], %{system_time: System.system_time()}, %{agent: agent_name, model: model, team: team})
  end

  def emit_call_stop(agent_name, model, team, duration_ms, ok?) do
    :telemetry.execute([:jay, :llm, :call, :stop], %{duration_ms: duration_ms}, %{agent: agent_name, model: model, team: team, ok: ok?})
  end

  def emit_cache_hit(agent_name, model) do
    :telemetry.execute([:jay, :llm, :cache, :hit], %{system_time: System.system_time()}, %{agent: agent_name, model: model})
  end

  def emit_budget_warn(team, ratio) do
    :telemetry.execute([:jay, :llm, :budget, :warn], %{ratio: ratio}, %{team: team})
  end
end
