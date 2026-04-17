defmodule Darwin.V2.Telemetry do
  @moduledoc """
  다윈 V2 Telemetry — :telemetry 이벤트 핸들러 + emit 헬퍼.

  처리 이벤트:
    [:darwin, :v2, :llm, :call]         — LLM 호출 메트릭
    [:darwin, :v2, :pipeline, :stage]   — 파이프라인 단계 완료
    [:darwin, :v2, :paper, :evaluated]  — 논문 점수 기록
    [:darwin, :v2, :paper, :implemented]— 논문 구현 기록
    [:darwin, :v2, :autonomy, :changed] — 자율 레벨 변경

  setup/0를 애플리케이션 시작 시 호출하여 핸들러 등록.
  """

  require Logger

  @handler_id "darwin-v2-telemetry"

  @events [
    [:darwin, :v2, :llm,       :call],
    [:darwin, :v2, :pipeline,  :stage],
    [:darwin, :v2, :paper,     :evaluated],
    [:darwin, :v2, :paper,     :implemented],
    [:darwin, :v2, :autonomy,  :changed]
  ]

  # ──────────────────────────────────────────────
  # 핸들러 등록
  # ──────────────────────────────────────────────

  @doc "애플리케이션 시작 시 호출 — :telemetry 핸들러 등록."
  @spec setup() :: :ok
  def setup do
    # 기존 핸들러가 있으면 먼저 제거 (재시작 안전)
    :telemetry.detach(@handler_id)

    :telemetry.attach_many(
      @handler_id,
      @events,
      &__MODULE__.handle_event/4,
      nil
    )

    Logger.info("[다윈V2 텔레메트리] #{length(@events)}개 이벤트 핸들러 등록 완료")
    :ok
  end

  # ──────────────────────────────────────────────
  # 이벤트 핸들러
  # ──────────────────────────────────────────────

  @doc false
  def handle_event([:darwin, :v2, :llm, :call], measurements, metadata, _config) do
    tokens     = Map.get(measurements, :tokens,     0)
    latency_ms = Map.get(measurements, :latency_ms, 0)
    agent      = Map.get(metadata,     :agent,      "unknown")
    model      = Map.get(metadata,     :model,      "unknown")

    Logger.debug(
      "[다윈V2 텔레메트리] LLM 호출 — agent=#{agent}, model=#{model}, tokens=#{tokens}, latency=#{latency_ms}ms"
    )

    # CostTracker에 토큰 기록 (tokens_input/output 분리 없이 전체로 처리)
    Task.start(fn ->
      Darwin.V2.LLM.CostTracker.track_tokens(%{
        agent:         to_string(agent),
        model:         to_string(model),
        provider:      Map.get(metadata, :provider, "anthropic"),
        tokens_input:  Map.get(measurements, :tokens_input,  div(tokens, 2)),
        tokens_output: Map.get(measurements, :tokens_output, div(tokens, 2))
      })
    end)
  rescue
    _ -> :ok
  end

  def handle_event([:darwin, :v2, :pipeline, :stage], measurements, metadata, _config) do
    stage      = Map.get(metadata,     :stage,    "unknown")
    duration   = Map.get(measurements, :duration, 0)
    paper_id   = Map.get(metadata,     :paper_id, nil)

    Logger.info(
      "[다윈V2 텔레메트리] 파이프라인 단계 완료 — stage=#{stage}" <>
      if(paper_id, do: ", paper=#{paper_id}", else: "") <>
      if(duration > 0, do: ", duration=#{duration}ms", else: "")
    )
  end

  def handle_event([:darwin, :v2, :paper, :evaluated], measurements, metadata, _config) do
    score    = Map.get(measurements, :score,    0)
    paper_id = Map.get(metadata,     :paper_id, "unknown")

    Logger.info("[다윈V2 텔레메트리] 논문 평가됨 — paper=#{paper_id}, score=#{score}")

    # 고적합 논문 표시
    if score >= 6 do
      Logger.info("[다윈V2 텔레메트리] 고적합 논문! score=#{score}")
    end
  end

  def handle_event([:darwin, :v2, :paper, :implemented], _measurements, metadata, _config) do
    paper_id = Map.get(metadata, :paper_id, "unknown")
    team     = Map.get(metadata, :team,     "darwin")
    Logger.info("[다윈V2 텔레메트리] 논문 구현 완료 — paper=#{paper_id}, team=#{team}")
  end

  def handle_event([:darwin, :v2, :autonomy, :changed], measurements, metadata, _config) do
    old_level = Map.get(measurements, :old_level, 0)
    new_level = Map.get(measurements, :new_level, 0)
    reason    = Map.get(metadata,     :reason,    "unknown")

    direction = if new_level > old_level, do: "승급", else: "강등"
    Logger.info(
      "[다윈V2 텔레메트리] 자율 레벨 #{direction} — L#{old_level} → L#{new_level}, reason=#{reason}"
    )
  end

  def handle_event(event, measurements, metadata, _config) do
    Logger.debug(
      "[다윈V2 텔레메트리] 알 수 없는 이벤트: #{inspect(event)}, measurements=#{inspect(measurements)}, metadata=#{inspect(metadata)}"
    )
  end

  # ──────────────────────────────────────────────
  # emit 헬퍼
  # ──────────────────────────────────────────────

  @doc "LLM 호출 메트릭 emit."
  @spec emit_llm_call(String.t(), String.t(), non_neg_integer(), non_neg_integer()) :: :ok
  def emit_llm_call(agent, model, tokens, latency_ms) do
    :telemetry.execute(
      [:darwin, :v2, :llm, :call],
      %{tokens: tokens, latency_ms: latency_ms},
      %{agent: agent, model: model}
    )
    :ok
  end

  @doc "논문 평가 완료 emit."
  @spec emit_paper_evaluated(String.t(), number()) :: :ok
  def emit_paper_evaluated(paper_id, score) do
    :telemetry.execute(
      [:darwin, :v2, :paper, :evaluated],
      %{score: score},
      %{paper_id: paper_id}
    )
    :ok
  end

  @doc "논문 구현 완료 emit."
  @spec emit_paper_implemented(String.t(), String.t()) :: :ok
  def emit_paper_implemented(paper_id, team \\ "darwin") do
    :telemetry.execute(
      [:darwin, :v2, :paper, :implemented],
      %{timestamp: System.system_time()},
      %{paper_id: paper_id, team: team}
    )
    :ok
  end

  @doc "파이프라인 단계 완료 emit."
  @spec emit_pipeline_stage(atom() | String.t(), keyword()) :: :ok
  def emit_pipeline_stage(stage, opts \\ []) do
    duration  = Keyword.get(opts, :duration_ms, 0)
    paper_id  = Keyword.get(opts, :paper_id, nil)

    :telemetry.execute(
      [:darwin, :v2, :pipeline, :stage],
      %{duration: duration},
      %{stage: to_string(stage), paper_id: paper_id}
    )
    :ok
  end

  @doc "자율 레벨 변경 emit."
  @spec emit_autonomy_changed(non_neg_integer(), non_neg_integer(), String.t()) :: :ok
  def emit_autonomy_changed(old_level, new_level, reason \\ "unknown") do
    :telemetry.execute(
      [:darwin, :v2, :autonomy, :changed],
      %{old_level: old_level, new_level: new_level},
      %{reason: reason}
    )
    :ok
  end

  @doc "LLM 호출 시간 측정 헬퍼 — fun 실행 후 자동 emit."
  @spec measure_llm_call(String.t(), String.t(), (-> {:ok, any()} | {:error, any()})) ::
          {:ok, any()} | {:error, any()}
  def measure_llm_call(agent, model, fun) do
    start_ms = System.monotonic_time(:millisecond)

    result = fun.()

    latency_ms = System.monotonic_time(:millisecond) - start_ms

    tokens =
      case result do
        {:ok, content} when is_binary(content) -> div(String.length(content), 3)
        _ -> 0
      end

    emit_llm_call(agent, model, tokens, latency_ms)

    result
  end
end
