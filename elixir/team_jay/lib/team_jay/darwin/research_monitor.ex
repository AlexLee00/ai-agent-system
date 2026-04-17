defmodule TeamJay.Darwin.ResearchMonitor do
  @moduledoc """
  다윈팀 리서치 모니터 — 파이프라인 헬스체크 오케스트레이터

  research-monitor.ts (10분 주기)의 Elixir 오케스트레이터.
  파이프라인 전체 상태를 모니터링하고 이상 감지 시 대응.

  역할:
  - PortAgent :darwin_monitor 결과 이벤트 처리
  - 파이프라인 중단 감지 → TeamLead.pipeline_failure()
  - 24시간 무스캔 감지 → Scanner.trigger_scan()
  - 자율 레벨 강등 조건 감지 (연속 3회 실패)
  - 상태 요약 제공 (GrowthCycle SENSE 단계용)
  """

  use GenServer
  require Logger

  alias TeamJay.Darwin.{TeamLead, Scanner}
  alias TeamJay.HubClient
  alias TeamJay.Repo

  @check_interval_ms  10 * 60 * 1000  # 10분 주기 헬스체크
  @stale_threshold_h  24              # 24시간 이상 스캔 없으면 경고

  defstruct [
    consecutive_failures: 0,
    last_check_at: nil,
    last_paper_at: nil,
    pipeline_healthy: true
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @impl true
  def init(_opts) do
    Process.send_after(self(), :health_check, 60_000)  # 1분 후 첫 체크
    Logger.info("[DarwinMonitor] 리서치 모니터 시작!")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:health_check, state) do
    new_state = do_health_check(state)
    Process.send_after(self(), :health_check, @check_interval_ms)
    {:noreply, new_state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      pipeline_healthy: state.pipeline_healthy,
      consecutive_failures: state.consecutive_failures,
      last_check_at: state.last_check_at,
      last_paper_at: state.last_paper_at
    }, state}
  end

  # ── 내부 ───────────────────────────────────────────────────────────

  defp do_health_check(state) do
    new_state = %{state | last_check_at: DateTime.utc_now()}

    case fetch_pipeline_stats() do
      {:ok, stats} ->
        check_results = [
          check_scan_freshness(stats),
          check_evaluation_health(stats),
          check_pipeline_stall(stats)
        ]

        issues = Enum.filter(check_results, &(&1 != :ok))

        if issues == [] do
          if not new_state.pipeline_healthy do
            Logger.info("[DarwinMonitor] 파이프라인 복구!")
            HubClient.post_alarm("✅ 다윈팀 파이프라인 정상 복구", "darwin-monitor", "darwin")
          end
          %{new_state |
            pipeline_healthy: true,
            consecutive_failures: 0,
            last_paper_at: stats.last_paper_at
          }
        else
          handle_issues(issues, new_state, stats)
        end

      {:error, reason} ->
        Logger.warning("[DarwinMonitor] 상태 조회 실패: #{inspect(reason)}")
        new_state
    end
  end

  defp fetch_pipeline_stats do
    case Repo.query("""
      SELECT
        COUNT(*)::int                                   AS papers_24h,
        COUNT(*) FILTER (WHERE score IS NOT NULL)::int AS scored_24h,
        MAX(created_at)                                AS last_paper_at
      FROM rag_research
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    """, []) do
      {:ok, %{rows: [[papers, scored, last_at] | _]}} ->
        {:ok, %{
          papers_24h: papers || 0,
          scored_24h: scored || 0,
          last_paper_at: last_at
        }}
      error ->
        {:error, error}
    end
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp check_scan_freshness(%{last_paper_at: nil}) do
    {:warn, :no_papers_ever}
  end

  defp check_scan_freshness(%{last_paper_at: last_at}) when last_at != nil do
    hours_ago = DateTime.diff(DateTime.utc_now(), last_at, :second) / 3600

    if hours_ago >= @stale_threshold_h do
      {:warn, :stale_scan, hours_ago}
    else
      :ok
    end
  end

  defp check_scan_freshness(_), do: :ok

  defp check_evaluation_health(%{papers_24h: p, scored_24h: s}) when p > 0 do
    eval_rate = s / p
    if eval_rate < 0.5 do
      {:warn, :low_eval_rate, eval_rate}
    else
      :ok
    end
  end

  defp check_evaluation_health(_), do: :ok

  defp check_pipeline_stall(%{papers_24h: 0}) do
    {:warn, :no_activity}
  end

  defp check_pipeline_stall(_), do: :ok

  defp handle_issues(issues, state, stats) do
    new_failures = state.consecutive_failures + 1
    Logger.warning("[DarwinMonitor] 이슈 #{length(issues)}개: #{inspect(issues)}")

    Enum.each(issues, fn
      {:warn, :stale_scan, hours} ->
        Logger.warning("[DarwinMonitor] #{round(hours)}시간 스캔 없음 → 스캔 트리거")
        Task.start(fn -> Scanner.trigger_scan() end)

      {:warn, :no_activity} ->
        Logger.warning("[DarwinMonitor] 24시간 논문 없음 → 스캔 트리거")
        Task.start(fn -> Scanner.trigger_scan() end)

      {:warn, :low_eval_rate, rate} ->
        Logger.warning("[DarwinMonitor] 평가율 낮음: #{Float.round(rate * 100, 1)}%")

      {:warn, :no_papers_ever} ->
        Logger.info("[DarwinMonitor] 논문 없음 (초기 상태)")

      _ -> :ok
    end)

    if new_failures >= 3 do
      Logger.error("[DarwinMonitor] 연속 #{new_failures}회 이슈 → pipeline_failure 보고")
      TeamLead.pipeline_failure("#{new_failures}회 연속 파이프라인 이슈")
      HubClient.post_alarm(
        "⚠️ 다윈팀 파이프라인 이상!\n연속 #{new_failures}회 감지\n논문 24h: #{stats.papers_24h}건\n자동 스캔 트리거 완료",
        "darwin-monitor", "darwin"
      )
    end

    %{state |
      pipeline_healthy: false,
      consecutive_failures: new_failures
    }
  end
end
