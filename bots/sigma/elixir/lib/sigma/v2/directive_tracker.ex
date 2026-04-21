defmodule Sigma.V2.DirectiveTracker do
  @moduledoc """
  Directive 이행 추적 (Phase O).

  시그마가 발행한 Directive가 실제로 각 팀에서 이행됐는지 추적.
  - 발행 시 sigma_directive_tracking에 기록
  - 48시간 후 이행 여부 확인 → 미달 시 Telegram 알림
  - 주간 이행율 집계
  """

  require Logger

  @fulfillment_check_hours 48

  @doc "MAPE-K 사이클 결과를 DirectiveTracking에 기록."
  @spec record_cycle(String.t(), [map()]) :: :ok
  def record_cycle(cycle_id, results) when is_list(results) do
    Enum.each(results, fn result ->
      feedback = result[:feedback] || %{}
      team = feedback[:target_team] || "unknown"
      feedback_type = feedback[:feedback_type] || "general"
      status = to_string(result[:status] || "unknown")

      sql = """
      INSERT INTO sigma_directive_tracking
        (cycle_id, team, feedback_type, issued_status, issued_at, created_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      """

      Jay.Core.Repo.query(sql, [cycle_id, team, feedback_type, status])
    end)

    :ok
  rescue
    e ->
      Logger.warning("[Sigma.V2.DirectiveTracker] record_cycle 실패: #{inspect(e)}")
      :ok
  end

  @doc "주간 미이행 Directive 체크 — MapeKLoop 주간 Knowledge에서 호출."
  @spec check_fulfillment_weekly() :: :ok
  def check_fulfillment_weekly do
    sql = """
    SELECT id, cycle_id, team, feedback_type, issued_at
    FROM sigma_directive_tracking
    WHERE issued_at < NOW() - INTERVAL '#{@fulfillment_check_hours} hours'
      AND fulfilled_at IS NULL
      AND issued_status = 'ok'
    ORDER BY issued_at DESC
    LIMIT 20
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows, columns: cols}} ->
        atom_cols = Enum.map(cols, &String.to_atom/1)
        unfulfilled = Enum.map(rows, fn row -> Enum.zip(atom_cols, row) |> Map.new() end)

        Enum.each(unfulfilled, fn directive ->
          try do
            Sigma.V2.TelegramReporter.on_directive_unfulfilled(
              directive[:team] || "unknown",
              to_string(directive[:cycle_id] || ""),
              %{
                issued_at: directive[:issued_at],
                feedback_type: directive[:feedback_type],
                fulfilled: false
              }
            )
          rescue
            _ -> :ok
          end
        end)

        Logger.info("[Sigma.V2.DirectiveTracker] 주간 미이행 점검: #{length(unfulfilled)}건")

      _ ->
        Logger.debug("[Sigma.V2.DirectiveTracker] DB 접근 불가")
    end

    :ok
  rescue
    e ->
      Logger.warning("[Sigma.V2.DirectiveTracker] check_fulfillment_weekly 실패: #{inspect(e)}")
      :ok
  end

  @doc "Directive 이행 완료 표시 (팀이 자체 보고 시 호출)."
  @spec mark_fulfilled(String.t(), String.t()) :: :ok | {:error, term()}
  def mark_fulfilled(cycle_id, team) do
    sql = """
    UPDATE sigma_directive_tracking
    SET fulfilled_at = NOW()
    WHERE cycle_id = $1 AND team = $2 AND fulfilled_at IS NULL
    """

    case Jay.Core.Repo.query(sql, [cycle_id, team]) do
      {:ok, _} ->
        Logger.info("[Sigma.V2.DirectiveTracker] Directive 이행 완료: cycle=#{cycle_id}, team=#{team}")
        :ok

      {:error, reason} ->
        {:error, reason}
    end
  rescue
    e -> {:error, e}
  end

  @doc "팀별 최근 이행률 조회."
  @spec fulfillment_rate_by_team(integer()) :: map()
  def fulfillment_rate_by_team(days \\ 30) do
    sql = """
    SELECT
      team,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE fulfilled_at IS NOT NULL)::float / NULLIF(COUNT(*), 0) AS rate
    FROM sigma_directive_tracking
    WHERE issued_at >= NOW() - INTERVAL '#{days} days'
    GROUP BY team
    ORDER BY rate DESC NULLS LAST
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Map.new(rows, fn [team, total, rate] ->
          {team, %{total: total, rate: rate || 0.0}}
        end)

      _ -> %{}
    end
  rescue
    _ -> %{}
  end
end
