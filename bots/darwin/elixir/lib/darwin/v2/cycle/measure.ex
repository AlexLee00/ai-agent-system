defmodule Darwin.V2.Cycle.Measure do
  @moduledoc """
  다윈 V2 Measure 사이클 — 8단계 R&D 루프의 Measure 단계.

  research_registry "measured" 상태를 활성화하고
  적용된 논문의 실제 효과를 24h / 7d / 30d 구간에서 측정·기록.

  ## 핵심 기능
  - schedule_measurement/2  적용 후 측정 타이머 예약
  - effect_observed/5       실제 측정 결과 기록 (read-only DB 갱신)
  - pending_measurements/0  측정 대기 중인 항목 조회
  - run_due/0               만기된 측정 일괄 실행

  ## 측정 구간
    24h, 7d, 30d (research_registry "applied" → "measured" 전이는 30d 완료 후)

  Kill Switch: DARWIN_MEASURE_STAGE_ENABLED=true
  """

  use GenServer
  require Logger

  alias Jay.Core.Repo
  alias Darwin.V2.ResearchRegistry

  @intervals [
    {"24h", 24 * 60 * 60},
    {"7d", 7 * 24 * 60 * 60},
    {"30d", 30 * 24 * 60 * 60}
  ]

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl GenServer
  def init(_opts) do
    Logger.info("[darwin/cycle.measure] Measure 단계 기동")
    {:ok, %{measurements_done: 0, last_run_at: nil}}
  end

  @doc "현재 상태 조회."
  def status, do: GenServer.call(__MODULE__, :status)

  @doc "만기 측정 일괄 실행 (launchd 또는 MAPE-K에서 호출)."
  def run_due, do: GenServer.cast(__MODULE__, :run_due)

  @impl GenServer
  def handle_call(:status, _from, state) do
    {:reply, Map.put(state, :phase, :measure), state}
  end

  @impl GenServer
  def handle_cast(:run_due, state) do
    count = do_run_due()
    new_state = %{state | measurements_done: state.measurements_done + count, last_run_at: DateTime.utc_now()}
    {:noreply, new_state}
  end

  # ────────────────────────────────────────────────
  # Public API
  # ────────────────────────────────────────────────

  @doc """
  논문 적용 후 측정 스케줄 등록.
  24h / 7d / 30d 각 구간에 대해 darwin_effect_measurements 예약 행 삽입.

  Kill Switch: DARWIN_MEASURE_STAGE_ENABLED=true
  """
  @spec schedule_measurement(String.t(), keyword()) :: :ok | {:skip, :disabled}
  def schedule_measurement(paper_id, opts \\ []) do
    if enabled?() do
      hypothesis_id = Keyword.get(opts, :hypothesis_id)
      metric_name = Keyword.get(opts, :metric_name, "general")
      value_before = Keyword.get(opts, :value_before)

      @intervals
      |> Enum.each(fn {label, secs} ->
        observe_at = DateTime.add(DateTime.utc_now(), secs, :second)
        insert_scheduled_row(paper_id, hypothesis_id, label, metric_name, value_before, observe_at)
      end)

      Logger.info("[darwin/cycle.measure] 측정 스케줄 등록 paper_id=#{paper_id}")
      :ok
    else
      {:skip, :disabled}
    end
  end

  @doc """
  실제 측정 결과 기록. read-only — DB 갱신만, 코드 수정 없음.

  Kill Switch: DARWIN_MEASURE_STAGE_ENABLED=true
  """
  @spec effect_observed(String.t(), String.t(), float(), float(), keyword()) ::
          {:ok, map()} | {:skip, :disabled} | {:error, term()}
  def effect_observed(paper_id, metric_name, value_before, value_after, opts \\ []) do
    if enabled?() do
      do_effect_observed(paper_id, metric_name, value_before, value_after, opts)
    else
      {:skip, :disabled}
    end
  end

  @doc "측정 대기 중 (value_after가 nil) 항목 조회."
  @spec pending_measurements() :: [map()]
  def pending_measurements do
    sql = """
    SELECT id, paper_id, hypothesis_id, interval_label, metric_name,
           value_before, observed_at
    FROM darwin_effect_measurements
    WHERE value_after IS NULL AND observed_at <= NOW()
    ORDER BY observed_at ASC
    LIMIT 100
    """

    case Repo.query(sql, []) do
      {:ok, %{rows: rows, columns: cols}} ->
        Enum.map(rows, fn row ->
          cols
          |> Enum.map(&String.to_atom/1)
          |> Enum.zip(row)
          |> Map.new()
        end)

      _ ->
        []
    end
  rescue
    _ -> []
  end

  # ────────────────────────────────────────────────
  # Private
  # ────────────────────────────────────────────────

  defp do_run_due do
    pending = pending_measurements()
    Logger.info("[darwin/cycle.measure] 측정 만기 #{length(pending)}건 처리")

    Enum.each(pending, fn row ->
      paper_id = row[:paper_id] || row["paper_id"]
      label = row[:interval_label] || row["interval_label"]
      Logger.debug("[darwin/cycle.measure] 자동 측정 paper_id=#{paper_id} interval=#{label}")
    end)

    # 30d 측정 완료된 논문을 measured 단계로 전이
    promote_to_measured()

    length(pending)
  end

  defp do_effect_observed(paper_id, metric_name, value_before, value_after, opts) do
    interval_label = Keyword.get(opts, :interval_label, "manual")
    hypothesis_id = Keyword.get(opts, :hypothesis_id)
    notes = Keyword.get(opts, :notes)
    delta = value_after - value_before
    delta_pct = if value_before != 0, do: delta / abs(value_before) * 100.0, else: 0.0

    sql = """
    INSERT INTO darwin_effect_measurements
      (paper_id, hypothesis_id, interval_label, metric_name,
       value_before, value_after, delta, delta_pct, observed_at, notes, inserted_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9, NOW())
    ON CONFLICT DO NOTHING
    RETURNING id
    """

    params = [
      paper_id, hypothesis_id, interval_label, metric_name,
      value_before, value_after, delta, delta_pct, notes
    ]

    result_map = %{
      paper_id: paper_id,
      metric_name: metric_name,
      interval_label: interval_label,
      value_before: value_before,
      value_after: value_after,
      delta: delta,
      delta_pct: delta_pct
    }

    case Repo.query(sql, params) do
      {:ok, _} ->
        Logger.info("[darwin/cycle.measure] 효과 기록 paper_id=#{paper_id} " <>
          "metric=#{metric_name} delta=#{Float.round(delta, 4)}")

        if hypothesis_id do
          update_hypothesis_status(hypothesis_id, delta)
        end

        {:ok, result_map}

      {:error, reason} ->
        Logger.error("[darwin/cycle.measure] effect_observed 실패: #{inspect(reason)}")
        {:error, reason}
    end
  rescue
    e -> {:error, e}
  end

  defp insert_scheduled_row(paper_id, hypothesis_id, interval_label, metric_name, value_before, observe_at) do
    sql = """
    INSERT INTO darwin_effect_measurements
      (paper_id, hypothesis_id, interval_label, metric_name,
       value_before, observed_at, inserted_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    """

    case Repo.query(sql, [paper_id, hypothesis_id, interval_label, metric_name, value_before, observe_at]) do
      {:ok, _} -> :ok
      {:error, e} -> Logger.warning("[darwin/cycle.measure] 예약 삽입 실패: #{inspect(e)}")
    end
  rescue
    _ -> :ok
  end

  # 30d 측정까지 완료된 논문 → ResearchRegistry "measured" 전이
  defp promote_to_measured do
    sql = """
    SELECT DISTINCT paper_id
    FROM darwin_effect_measurements
    WHERE interval_label = '30d'
      AND value_after IS NOT NULL
    """

    case Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Enum.each(rows, fn [paper_id] ->
          ResearchRegistry.transition(paper_id, "measured", %{source: "measure_stage"})
        end)

      _ ->
        :ok
    end
  rescue
    _ -> :ok
  end

  defp update_hypothesis_status(hypothesis_id, delta) do
    status = if delta > 0, do: "confirmed", else: "refuted"

    Darwin.V2.HypothesisEngine.update_status(
      hypothesis_id,
      status,
      %{delta: delta, measured_at: DateTime.utc_now()}
    )
  end

  defp enabled? do
    System.get_env("DARWIN_MEASURE_STAGE_ENABLED") == "true"
  end
end
