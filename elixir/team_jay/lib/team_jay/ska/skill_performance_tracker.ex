defmodule TeamJay.Ska.SkillPerformanceTracker do
  @moduledoc """
  스킬별 성과 추적 + 트렌드 분석 GenServer.

  메트릭 (ska_skill_execution_log 기반):
  - 성공률 (24h / 7d / 30d)
  - 평균 실행 시간 (avg / p95)
  - 사용 빈도 (에이전트별)
  - 실패 패턴 (에러 유형별)

  Kill Switch: SKA_SKILL_REGISTRY_ENABLED (SkillRegistry와 동일 스위치)
  """
  use GenServer
  require Logger

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "특정 스킬 성과 조회"
  def performance(skill_name, period \\ :day) do
    GenServer.call(__MODULE__, {:performance, skill_name, period})
  end

  @doc "모든 스킬 성과 요약 (24h)"
  def summary_24h do
    GenServer.call(__MODULE__, :summary_24h)
  end

  @doc "최근 N일 간 성공률 하락 스킬 목록"
  def degrading_skills(opts \\ []) do
    days = Keyword.get(opts, :days, 7)
    threshold = Keyword.get(opts, :threshold, 0.8)
    GenServer.call(__MODULE__, {:degrading_skills, days, threshold})
  end

  # ─── GenServer 콜백 ──────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[SkillPerformanceTracker] 스킬 성과 추적기 시작")
    {:ok, %{}}
  end

  @impl true
  def handle_call({:performance, skill_name, period}, _from, state) do
    hours = period_to_hours(period)

    sql = """
    SELECT
      caller_agent,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
      ROUND(AVG(duration_ms)::numeric, 2) AS avg_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
    FROM ska_skill_execution_log
    WHERE skill_name = $1
      AND inserted_at > NOW() - ($2 || ' hours')::interval
    GROUP BY caller_agent
    ORDER BY total DESC
    """

    result =
      case Jay.Core.Repo.query(sql, [to_string(skill_name), hours]) do
        {:ok, %{rows: rows, columns: cols}} ->
          data = Enum.map(rows, fn row -> Enum.zip(cols, row) |> Map.new() end)
          {:ok, data}

        {:error, reason} ->
          Logger.warning("[SkillPerformanceTracker] 쿼리 실패: #{inspect(reason)}")
          {:error, reason}
      end

    {:reply, result, state}
  end

  @impl true
  def handle_call(:summary_24h, _from, state) do
    sql = """
    SELECT
      skill_name,
      COUNT(*) AS total_executions,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
      ROUND(
        100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0),
        2
      ) AS success_rate_pct,
      ROUND(AVG(duration_ms)::numeric, 2) AS avg_ms
    FROM ska_skill_execution_log
    WHERE inserted_at > NOW() - INTERVAL '24 hours'
    GROUP BY skill_name
    ORDER BY total_executions DESC
    """

    result =
      case Jay.Core.Repo.query(sql, []) do
        {:ok, %{rows: rows, columns: cols}} ->
          data = Enum.map(rows, fn row -> Enum.zip(cols, row) |> Map.new() end)
          {:ok, data}

        {:error, reason} ->
          {:error, reason}
      end

    {:reply, result, state}
  end

  @impl true
  def handle_call({:degrading_skills, days, threshold}, _from, state) do
    hours_recent = 24
    hours_baseline = days * 24

    sql = """
    WITH baseline AS (
      SELECT skill_name,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS rate
      FROM ska_skill_execution_log
      WHERE inserted_at > NOW() - ($2 || ' hours')::interval
      GROUP BY skill_name
    ),
    recent AS (
      SELECT skill_name,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) AS rate
      FROM ska_skill_execution_log
      WHERE inserted_at > NOW() - ($1 || ' hours')::interval
      GROUP BY skill_name
    )
    SELECT r.skill_name, r.rate AS recent_rate, b.rate AS baseline_rate
    FROM recent r
    JOIN baseline b ON r.skill_name = b.skill_name
    WHERE r.rate < b.rate * $3
    ORDER BY (b.rate - r.rate) DESC
    """

    result =
      case Jay.Core.Repo.query(sql, [hours_recent, hours_baseline, threshold]) do
        {:ok, %{rows: rows, columns: cols}} ->
          data = Enum.map(rows, fn row -> Enum.zip(cols, row) |> Map.new() end)
          {:ok, data}

        {:error, reason} ->
          {:error, reason}
      end

    {:reply, result, state}
  end

  # ─── 헬퍼 ────────────────────────────────────────────────

  defp period_to_hours(:hour), do: 1
  defp period_to_hours(:day), do: 24
  defp period_to_hours(:week), do: 168
  defp period_to_hours(:month), do: 720
  defp period_to_hours(n) when is_integer(n), do: n
  defp period_to_hours(_), do: 24
end
