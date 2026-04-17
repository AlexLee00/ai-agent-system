defmodule Darwin.V2.Telemetry do
  @moduledoc """
  다윈 V2 OpenTelemetry 계측 — 사이클 단계별 span 추적.
  메트릭: 논문 수집/평가/구현 건수, LLM 비용, 자율 레벨 변화.
  """

  require Logger

  @doc "사이클 단계 시작 추적."
  @spec start_span(atom(), map()) :: reference()
  def start_span(stage, attrs \\ %{}) do
    span_ref = make_ref()
    attrs_with_team = Map.merge(%{team: "darwin", stage: to_string(stage)}, attrs)
    :telemetry.execute([:darwin, :cycle, stage, :start], %{system_time: System.system_time()}, attrs_with_team)
    span_ref
  end

  @doc "사이클 단계 완료 추적."
  @spec end_span(reference(), atom(), map()) :: :ok
  def end_span(_span_ref, stage, attrs \\ %{}) do
    :telemetry.execute([:darwin, :cycle, stage, :stop], %{duration: System.monotonic_time()}, attrs)
    :ok
  end

  @doc "논문 발견 카운터 증가."
  @spec count_discovered(integer()) :: :ok
  def count_discovered(count) do
    :telemetry.execute([:darwin, :papers, :discovered], %{count: count}, %{team: "darwin"})
    :ok
  end

  @doc "LLM 호출 비용 추적."
  @spec track_llm_cost(String.t(), float()) :: :ok
  def track_llm_cost(agent, cost_usd) do
    :telemetry.execute([:darwin, :llm, :cost], %{cost_usd: cost_usd}, %{agent: agent})
    :ok
  end
end
