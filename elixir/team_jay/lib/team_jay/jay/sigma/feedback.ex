defmodule TeamJay.Jay.Sigma.Feedback do
  @moduledoc """
  시그마 피드백 수집기 (sigma-feedback.ts Elixir 포트).
  팀별 피드백을 DB에 기록 + RAG 저장.
  """

  require Logger

  @schema "sigma"

  @doc "DB 스키마 초기화"
  def ensure_tables do
    sqls = [
      """
      CREATE SCHEMA IF NOT EXISTS #{@schema}
      """,
      """
      CREATE TABLE IF NOT EXISTS #{@schema}.daily_runs (
        id BIGSERIAL PRIMARY KEY,
        run_date DATE NOT NULL DEFAULT CURRENT_DATE,
        formation JSONB NOT NULL DEFAULT '{}'::jsonb,
        events JSONB NOT NULL DEFAULT '{}'::jsonb,
        report TEXT,
        insight_count INTEGER NOT NULL DEFAULT 0,
        feedback_count INTEGER NOT NULL DEFAULT 0,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      """,
      """
      CREATE INDEX IF NOT EXISTS idx_sigma_daily_runs_date
      ON #{@schema}.daily_runs(run_date DESC, created_at DESC)
      """,
      """
      CREATE TABLE IF NOT EXISTS #{@schema}.feedback_effectiveness (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        feedback_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        target_team VARCHAR(20) NOT NULL,
        feedback_type VARCHAR(30) NOT NULL,
        content TEXT,
        formation JSONB DEFAULT '{}'::jsonb,
        analyst_used VARCHAR(30),
        before_metric JSONB DEFAULT '{}'::jsonb,
        after_metric JSONB DEFAULT '{}'::jsonb,
        effectiveness DOUBLE PRECISION,
        effective BOOLEAN,
        measured_at TIMESTAMPTZ,
        measured BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
      """,
      """
      CREATE INDEX IF NOT EXISTS idx_sigma_fb_team
      ON #{@schema}.feedback_effectiveness(target_team, feedback_date DESC)
      """
    ]

    Enum.each(sqls, fn sql ->
      TeamJay.HubClient.pg_query(sql, "public")
    end)
    :ok
  rescue
    e ->
      Logger.warning("[Sigma.Feedback] ensure_tables 실패: #{Exception.message(e)}")
      :error
  end

  @doc "팀별 메트릭 수집 (sigma-feedback.ts collectTeamMetric 포트)"
  def collect_team_metric(team) when is_atom(team) do
    TeamJay.Jay.TeamConnector.collect(team)
  end

  @doc "피드백 레코드 저장 (feedback_effectiveness)"
  def record_feedback(target_team, feedback_type, content, analyst, before_metric, opts \\ []) do
    formation = Keyword.get(opts, :formation, %{})
    sql = """
      INSERT INTO #{@schema}.feedback_effectiveness
        (target_team, feedback_type, content, analyst_used, before_metric, formation)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    """
    params = [
      to_string(target_team),
      to_string(feedback_type),
      content,
      to_string(analyst),
      Jason.encode!(before_metric || %{}),
      Jason.encode!(formation)
    ]

    case TeamJay.HubClient.pg_query(
      sql <> " -- params: #{inspect(params)}",
      @schema
    ) do
      {:ok, _} ->
        Logger.debug("[Sigma.Feedback] 피드백 저장: #{target_team}/#{feedback_type}")
        :ok
      {:error, err} ->
        Logger.warning("[Sigma.Feedback] 저장 실패: #{inspect(err)}")
        :error
    end
  rescue
    _ -> :error
  end

  @doc "일일 실행 기록 저장 (daily_runs)"
  def record_daily_run(formation, events, report, insight_count, feedback_count) do
    _params = [
      Jason.encode!(formation),
      Jason.encode!(events),
      report,
      insight_count,
      feedback_count
    ]

    # Hub API pg_query는 파라미터 바인딩을 JSON으로 전달
    TeamJay.HubClient.pg_query(
      "INSERT INTO #{@schema}.daily_runs (formation, events, report, insight_count, feedback_count) " <>
      "VALUES ('#{Jason.encode!(formation)}', '#{Jason.encode!(events)}', " <>
      "'#{String.replace(report || "", "'", "''")}', #{insight_count}, #{feedback_count})",
      @schema
    )
    :ok
  rescue
    e ->
      Logger.warning("[Sigma.Feedback] daily_run 저장 실패: #{Exception.message(e)}")
      :error
  end

  @doc "피드백 효과 측정 업데이트 (7일 후 after_metric 비교)"
  def measure_effectiveness(feedback_id, after_metric, effective) do
    effectiveness = if effective, do: 1.0, else: 0.0
    TeamJay.HubClient.pg_query(
      "UPDATE #{@schema}.feedback_effectiveness " <>
      "SET after_metric = '#{Jason.encode!(after_metric)}', " <>
      "effective = #{effective}, effectiveness = #{effectiveness}, " <>
      "measured = TRUE, measured_at = NOW() " <>
      "WHERE id = '#{feedback_id}'",
      @schema
    )
    :ok
  rescue
    _ -> :error
  end
end
