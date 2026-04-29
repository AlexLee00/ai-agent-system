defmodule Darwin.V2.TeamConnector do
  @moduledoc """
  다윈팀 V2 팀 커넥터 — KPI 수집 + 기술 요청 큐 + 연구 결과 전파.

  Phase A (9 팀 통합):
  - submit_tech_request/5  팀 기술 요청 등록
  - pending_requests/0     DISCOVER 단계에서 우선 검색할 요청 목록
  - notify_team/3          연구 결과를 해당 팀 commander에게 알림 (Jay agent-bus)
  - mark_resolved/2        요청을 resolved 처리

  Kill Switch: DARWIN_TEAM_INTEGRATION_ENABLED=true
  """

  require Logger
  alias Jay.Core.Repo

  # ────────────────────────────────────────────────
  # Phase A: 9 팀 통합 API
  # ────────────────────────────────────────────────

  @doc """
  9 팀 commander가 다윈팀에 기술 요청을 등록.

  ## 파라미터
  - team        팀명 (e.g. "luna", "blog", "ska")
  - agent       요청 에이전트 (e.g. "luna-commander")
  - request_type "prompt" | "algorithm" | "library" | "framework"
  - description 요청 내용
  - priority    우선순위 1~10 (기본 5)

  Kill Switch: DARWIN_TEAM_INTEGRATION_ENABLED
  """
  @spec submit_tech_request(String.t(), String.t(), String.t(), String.t(), integer()) ::
          {:ok, integer()} | {:skip, :disabled} | {:error, term()}
  def submit_tech_request(team, agent, request_type, description, priority \\ 5) do
    if team_integration_enabled?() do
      do_submit_tech_request(team, agent, request_type, description, priority)
    else
      Logger.debug("[darwin/team_connector] team_integration 비활성 — 요청 무시 team=#{team}")
      {:skip, :disabled}
    end
  end

  defp do_submit_tech_request(team, agent, request_type, description, priority) do
    sql = """
    INSERT INTO darwin_team_tech_requests
      (requesting_team, requesting_agent, request_type, description, priority, status, inserted_at)
    VALUES ($1, $2, $3, $4, $5, 'queued', NOW())
    RETURNING id
    """

    case Repo.query(sql, [team, agent, request_type, description, priority]) do
      {:ok, %{rows: [[id]]}} ->
        Logger.info("[darwin/team_connector] 기술 요청 등록 id=#{id} team=#{team} type=#{request_type}")
        {:ok, id}

      {:error, reason} ->
        Logger.error("[darwin/team_connector] 요청 등록 실패: #{inspect(reason)}")
        {:error, reason}
    end
  rescue
    e ->
      Logger.error("[darwin/team_connector] submit_tech_request 예외: #{Exception.message(e)}")
      {:error, e}
  end

  @doc """
  DISCOVER 단계에서 처리할 pending 기술 요청 목록 반환.
  우선순위 내림차순 정렬.

  Kill Switch: DARWIN_TEAM_INTEGRATION_ENABLED
  """
  @spec pending_requests() :: [map()]
  def pending_requests do
    if team_integration_enabled?() do
      do_pending_requests()
    else
      []
    end
  end

  defp do_pending_requests do
    sql = """
    SELECT id, requesting_team, requesting_agent, request_type, description, priority
    FROM darwin_team_tech_requests
    WHERE status = 'queued'
    ORDER BY priority DESC, inserted_at ASC
    LIMIT 20
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

  @doc """
  연구 결과를 해당 팀 commander에게 Jay agent-bus로 알림.

  Kill Switch: DARWIN_TEAM_INTEGRATION_ENABLED
  """
  @spec notify_team(String.t(), map(), keyword()) :: :ok
  def notify_team(team, research_result, opts \\ []) do
    if team_integration_enabled?() do
      do_notify_team(team, research_result, opts)
    else
      :ok
    end
  end

  defp do_notify_team(team, research_result, opts) do
    request_id = Keyword.get(opts, :request_id)
    topic = "darwin.research.completed.#{team}"
    payload = Map.merge(research_result, %{target_team: team, request_id: request_id})

    Registry.dispatch(Jay.Core.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)

    Logger.info("[darwin/team_connector] 팀 알림 전송 team=#{team} topic=#{topic}")

    if request_id do
      mark_resolved(request_id, research_result[:paper_ids] || [])
    end

    :ok
  rescue
    e ->
      Logger.warning("[darwin/team_connector] notify_team 실패: #{Exception.message(e)}")
      :ok
  end

  @doc "요청을 resolved 처리하고 매칭된 논문 ID 기록."
  @spec mark_resolved(integer(), [integer()]) :: :ok
  def mark_resolved(request_id, paper_ids \\ []) do
    sql = """
    UPDATE darwin_team_tech_requests
    SET status = 'resolved', matched_papers = $2, resolved_at = NOW()
    WHERE id = $1
    """

    case Repo.query(sql, [request_id, paper_ids]) do
      {:ok, _} -> Logger.debug("[darwin/team_connector] 요청 resolved id=#{request_id}")
      {:error, e} -> Logger.warning("[darwin/team_connector] mark_resolved 실패: #{inspect(e)}")
    end

    :ok
  rescue
    _ -> :ok
  end

  # ────────────────────────────────────────────────
  # 기존 KPI 수집 API
  # ────────────────────────────────────────────────

  @spec get_status() :: map()
  def get_status do
    %{
      forwarded_count: 0,
      target_teams: [:luna, :blog, :claude, :ska, :jay],
      team_integration_enabled: team_integration_enabled?(),
      status: :ready
    }
  end

  @spec collect_kpi() :: map()
  def collect_kpi do
    autonomy_level =
      try do
        Darwin.V2.Lead.get_autonomy_level()
      rescue
        _ -> 3
      end

    if rag_research_available?() do
      case Repo.query(kpi_query(), []) do
        {:ok, %{rows: [[papers, high, avg, last_at]]}} ->
          %{
            metric_type: :research_ops,
            papers_7d: papers || 0,
            high_quality_7d: high || 0,
            avg_score: avg || 0.0,
            last_scan_at: last_at,
            autonomy_level: autonomy_level,
            pending_team_requests: length(pending_requests())
          }

        _ ->
          default_kpi(autonomy_level)
      end
    else
      default_kpi(autonomy_level)
    end
  end

  # ────────────────────────────────────────────────
  # Private
  # ────────────────────────────────────────────────

  defp team_integration_enabled? do
    System.get_env("DARWIN_TEAM_INTEGRATION_ENABLED") == "true"
  end

  defp kpi_query do
    if rag_research_has_score_column?() do
      """
      SELECT
        COUNT(*)::int AS papers_7d,
        COUNT(*) FILTER (WHERE score >= 6)::int AS high_quality_7d,
        COALESCE(AVG(score), 0)::numeric(4,1) AS avg_score,
        MAX(created_at) AS last_scan_at
      FROM reservation.rag_research
      WHERE created_at >= NOW() - INTERVAL '7 days'
      """
    else
      """
      SELECT
        COUNT(*)::int AS papers_7d,
        0::int AS high_quality_7d,
        0::numeric(4,1) AS avg_score,
        MAX(created_at) AS last_scan_at
      FROM reservation.rag_research
      WHERE created_at >= NOW() - INTERVAL '7 days'
      """
    end
  end

  defp default_kpi(autonomy_level) do
    %{
      metric_type: :research_ops,
      papers_7d: 0,
      high_quality_7d: 0,
      avg_score: 0.0,
      last_scan_at: nil,
      autonomy_level: autonomy_level,
      pending_team_requests: 0
    }
  end

  defp rag_research_available? do
    case Repo.query("SELECT to_regclass('reservation.rag_research')", []) do
      {:ok, %{rows: [[nil]]}} -> false
      {:ok, %{rows: [[_rel]]}} -> true
      _ -> false
    end
  end

  defp rag_research_has_score_column? do
    case Repo.query(
           """
           SELECT EXISTS (
             SELECT 1
             FROM information_schema.columns
             WHERE table_schema = 'reservation'
               AND table_name = 'rag_research'
               AND column_name = 'score'
           )
           """,
           []
         ) do
      {:ok, %{rows: [[true]]}} -> true
      _ -> false
    end
  end
end
