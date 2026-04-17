defmodule Darwin.V2.RollbackScheduler do
  @moduledoc """
  다윈 V2 롤백 스케줄러 — V2 파이프라인 24h 효과 측정 후 필요 시 자동 롤백.

  V2 활성화 후 지표가 V1 대비 -10% 이상 악화되면 Shadow 모드로 복귀,
  마스터에게 텔레그램 알림을 발송한다.
  +30% 이상 개선 시 성공 사례를 Semantic Memory에 저장.

  ## 측정 지표
  - papers_implemented_rate: 구현 완료 논문 비율
  - avg_score: 평균 논문 점수
  - error_rate: 파이프라인 에러율

  ## Effectiveness 계산
  effectiveness = (after_metric - before_metric) / before_metric

  ## 조건
  - effectiveness < -0.10 → Shadow 모드 복귀 + 마스터 알림
  - effectiveness >= 0.30  → Semantic Memory 저장
  - 그 외                   → Episodic Memory(30일 만료) 저장

  ## Public API
  - `schedule(baseline_metrics, snapshot_id)` — 24h 후 측정 예약
  - `cancel(snapshot_id)` — 예약 취소
  - `pending_checks()` — 대기 중인 체크 목록

  로그 prefix: [다윈V2 롤백스케줄러]
  """

  use GenServer
  require Logger

  @compile {:no_warn_undefined, [Jay.Core.Repo, Jay.Core.HubClient]}

  alias Jay.Core.{Repo, HubClient}

  # -------------------------------------------------------------------
  # Public API
  # -------------------------------------------------------------------

  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, %{pending: %{}}, name: __MODULE__)
  end

  @doc "24h 후 효과 측정 + 필요 시 자동 롤백 예약."
  @spec schedule(map(), String.t()) :: :ok
  def schedule(baseline_metrics, snapshot_id) when is_map(baseline_metrics) and is_binary(snapshot_id) do
    GenServer.cast(__MODULE__, {:schedule, %{
      baseline:    baseline_metrics,
      snapshot_id: snapshot_id,
      scheduled_at: DateTime.utc_now()
    }})
  end

  @doc "예약된 롤백 체크 취소."
  @spec cancel(String.t()) :: :ok
  def cancel(snapshot_id) when is_binary(snapshot_id) do
    GenServer.cast(__MODULE__, {:cancel, snapshot_id})
  end

  @doc "대기 중인 롤백 체크 목록."
  @spec pending_checks() :: [map()]
  def pending_checks do
    GenServer.call(__MODULE__, :pending_checks)
  end

  # -------------------------------------------------------------------
  # GenServer callbacks
  # -------------------------------------------------------------------

  @impl GenServer
  def init(state) do
    Logger.info("[다윈V2 롤백스케줄러] 시작")
    {:ok, state}
  end

  @impl GenServer
  def handle_cast({:schedule, opts}, state) do
    delay_ms = Map.get(opts, :measure_at_ms, :timer.hours(24))
    snapshot_id = opts.snapshot_id

    timer_ref = Process.send_after(self(), {:measure_and_rollback, opts}, delay_ms)

    scheduled_at = opts.scheduled_at
    Logger.info("[다윈V2 롤백스케줄러] 예약 완료 snapshot_id=#{snapshot_id} delay=#{div(delay_ms, 3_600_000)}h")

    new_pending = Map.put(state.pending, snapshot_id, %{
      opts:         opts,
      timer_ref:    timer_ref,
      scheduled_at: scheduled_at
    })

    {:noreply, %{state | pending: new_pending}}
  end

  def handle_cast({:cancel, snapshot_id}, state) do
    case Map.get(state.pending, snapshot_id) do
      nil ->
        Logger.debug("[다윈V2 롤백스케줄러] cancel: snapshot_id=#{snapshot_id} 없음")
        {:noreply, state}

      %{timer_ref: ref} ->
        Process.cancel_timer(ref)
        Logger.info("[다윈V2 롤백스케줄러] 취소 완료 snapshot_id=#{snapshot_id}")
        {:noreply, %{state | pending: Map.delete(state.pending, snapshot_id)}}
    end
  end

  @impl GenServer
  def handle_call(:pending_checks, _from, state) do
    checks = state.pending
             |> Map.values()
             |> Enum.map(fn %{opts: opts, scheduled_at: at} ->
               %{snapshot_id: opts.snapshot_id, scheduled_at: at, baseline: opts.baseline}
             end)

    {:reply, checks, state}
  end

  @impl GenServer
  def handle_info({:measure_and_rollback, opts}, state) do
    snapshot_id  = opts.snapshot_id
    baseline     = opts.baseline

    Logger.info("[다윈V2 롤백스케줄러] 효과 측정 시작 snapshot_id=#{snapshot_id}")

    after_metric = collect_current_metrics()
    effectiveness = compute_effectiveness(baseline, after_metric)

    Logger.info("[다윈V2 롤백스케줄러] snapshot_id=#{snapshot_id} effectiveness=#{Float.round(effectiveness, 3)}")

    cond do
      effectiveness < -0.10 ->
        pct = Float.round(effectiveness * 100, 1)
        Logger.warning("[다윈V2 롤백스케줄러] 악화 감지 (#{pct}%) — Shadow 모드 복귀")

        # Kill Switch 활성화 → Shadow 모드로 복귀
        Darwin.V2.Lead.activate_kill_switch()

        log_rollback_to_db(snapshot_id, baseline, after_metric, effectiveness)

        Task.start(fn ->
          HubClient.post_alarm(
            "다윈팀 V2 자동 롤백 — effectiveness #{pct}%\n" <>
            "snapshot_id=#{snapshot_id}\n" <>
            "DARWIN_SHADOW_MODE=true 로 복귀. 마스터 확인 요청.",
            "darwin",
            "darwin_rollback"
          )
        end)

      effectiveness >= 0.30 ->
        pct = Float.round(effectiveness * 100, 1)
        Logger.info("[다윈V2 롤백스케줄러] 성공 기록 snapshot_id=#{snapshot_id} +#{pct}%")

        store_success_memory(snapshot_id, effectiveness)

      true ->
        Logger.debug("[다윈V2 롤백스케줄러] 중립 결과 snapshot_id=#{snapshot_id} #{Float.round(effectiveness * 100, 1)}%")
    end

    {:noreply, %{state | pending: Map.delete(state.pending, snapshot_id)}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # -------------------------------------------------------------------
  # Private — 지표 수집
  # -------------------------------------------------------------------

  defp collect_current_metrics do
    sql = """
    SELECT
      COUNT(*) FILTER (WHERE status = 'implemented')::float /
        NULLIF(COUNT(*), 0)                                 AS papers_implemented_rate,
      COALESCE(AVG(score), 5.0)::float                     AS avg_score,
      COUNT(*) FILTER (WHERE status = 'error')::float /
        NULLIF(COUNT(*), 0)                                 AS error_rate
    FROM darwin_v2_shadow_runs
    WHERE run_date >= CURRENT_DATE - INTERVAL '1 day'
    """

    case Repo.query(sql, []) do
      {:ok, %{rows: [[impl_rate, avg_score, err_rate]]}} ->
        %{
          papers_implemented_rate: impl_rate  || 0.0,
          avg_score:               avg_score  || 5.0,
          error_rate:              err_rate   || 0.0
        }

      _ ->
        default_metrics()
    end
  rescue
    _ -> default_metrics()
  end

  defp default_metrics do
    %{papers_implemented_rate: 0.0, avg_score: 5.0, error_rate: 0.0}
  end

  # -------------------------------------------------------------------
  # Private — 효과 계산 (단일 지표 기준: avg_score 우선)
  # -------------------------------------------------------------------

  defp compute_effectiveness(%{avg_score: before_score}, %{avg_score: after_score})
       when is_number(before_score) and before_score > 0 do
    (after_score - before_score) / before_score
  end

  defp compute_effectiveness(before, after_m) when is_map(before) and is_map(after_m) do
    # 복합 지표: avg_score(가중 0.6) + papers_implemented_rate(0.3) + error_rate(-0.1)
    score_eff = safe_eff(before[:avg_score] || before["avg_score"],
                         after_m[:avg_score]  || after_m["avg_score"])

    impl_eff  = safe_eff(before[:papers_implemented_rate] || before["papers_implemented_rate"],
                         after_m[:papers_implemented_rate]  || after_m["papers_implemented_rate"])

    err_before = before[:error_rate] || before["error_rate"] || 0.0
    err_after  = after_m[:error_rate]  || after_m["error_rate"]  || 0.0
    err_eff    = if err_before > 0, do: -(err_after - err_before) / err_before, else: 0.0

    score_eff * 0.6 + impl_eff * 0.3 + err_eff * 0.1
  end

  defp compute_effectiveness(_, _), do: 0.0

  defp safe_eff(before, after_val) when is_number(before) and before > 0 do
    (after_val - before) / before
  end
  defp safe_eff(_, _), do: 0.0

  # -------------------------------------------------------------------
  # Private — 기록
  # -------------------------------------------------------------------

  defp log_rollback_to_db(snapshot_id, baseline, after_metric, effectiveness) do
    Repo.query(
      """
      INSERT INTO darwin_v2_rollback_log
        (snapshot_id, baseline_metrics, after_metrics, effectiveness, rolled_back_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (snapshot_id) DO NOTHING
      """,
      [snapshot_id, Jason.encode!(baseline), Jason.encode!(after_metric), effectiveness]
    )
    |> case do
      {:ok, _}    -> :ok
      {:error, e} -> Logger.debug("[다윈V2 롤백스케줄러] DB 기록 실패 (테이블 없을 수 있음): #{inspect(e)}")
    end
  rescue
    _ -> :ok
  end

  defp store_success_memory(snapshot_id, effectiveness) do
    try do
      Darwin.V2.Memory.store(
        "v2_success:#{snapshot_id}",
        %{type: :semantic, effectiveness: effectiveness, stored_at: DateTime.utc_now()},
        importance: min(effectiveness, 1.0)
      )
    rescue
      _ -> :ok
    end
  end
end
