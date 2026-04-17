defmodule Sigma.V2.Archivist do
  @moduledoc """
  Tier 0 관찰 로그 + Directive 감사 로그 저장.
  sigma_v2_directive_audit 테이블에 기록.
  참조: bots/sigma/docs/PLAN.md §6 Phase 2
  """

  @doc "Tier 0 관찰 기록."
  def log_observation(directive) do
    run_query(
      """
      INSERT INTO sigma_v2_directive_audit
        (directive_id, tier, team, action, executed_at, outcome)
      VALUES ($1, $2, $3, $4, NOW(), 'observed')
      """,
      [
        Ecto.UUID.generate(),
        directive.tier,
        directive.team,
        Jason.encode!(directive.action)
      ]
    )
  end

  @doc "Tier 1 Signal 전송 기록."
  def log_signal_sent(directive, signal_id) do
    run_query(
      """
      INSERT INTO sigma_v2_directive_audit
        (directive_id, tier, team, action, executed_at, outcome, principle_check_result)
      VALUES ($1, $2, $3, $4, NOW(), 'signal_sent', $5)
      """,
      [
        Ecto.UUID.generate(),
        directive.tier,
        directive.team,
        Jason.encode!(directive.action),
        Jason.encode!(%{signal_id: signal_id})
      ]
    )
  end

  @doc "Directive 실패 기록."
  def log_failure(directive, reason) do
    run_query(
      """
      INSERT INTO sigma_v2_directive_audit
        (directive_id, tier, team, action, executed_at, outcome, principle_check_result)
      VALUES ($1, $2, $3, $4, NOW(), 'failure', $5)
      """,
      [
        Ecto.UUID.generate(),
        directive.tier,
        directive.team,
        Jason.encode!(directive.action),
        Jason.encode!(%{reason: inspect(reason)})
      ]
    )
  end

  @doc "원칙 게이트에 차단된 Directive 기록."
  def log_blocked(directive, blocked_principles) do
    run_query(
      """
      INSERT INTO sigma_v2_directive_audit
        (directive_id, tier, team, action, executed_at, outcome, principle_check_result)
      VALUES ($1, $2, $3, $4, NOW(), 'blocked', $5)
      """,
      [
        Ecto.UUID.generate(),
        directive.tier,
        directive.team,
        Jason.encode!(directive.action),
        Jason.encode!(%{blocked_principles: blocked_principles})
      ]
    )
  end

  @doc "Tier 2 자동 적용 기록."
  def log_tier2_applied(directive, snapshot_id) do
    run_query(
      """
      INSERT INTO sigma_v2_directive_audit
        (directive_id, tier, team, action, executed_at, outcome, principle_check_result)
      VALUES ($1, $2, $3, $4, NOW(), 'tier2_applied', $5)
      """,
      [
        Ecto.UUID.generate(),
        directive.tier,
        directive.team,
        Jason.encode!(directive.action),
        Jason.encode!(%{snapshot_id: snapshot_id})
      ]
    )
  end

  @doc "롤백 기록."
  def log_rollback(opts, effectiveness) do
    run_query(
      """
      INSERT INTO sigma_v2_directive_audit
        (directive_id, tier, team, action, executed_at, outcome, principle_check_result)
      VALUES ($1, 2, $2, $3, NOW(), 'rollback', $4)
      """,
      [
        Ecto.UUID.generate(),
        opts[:team] || "unknown",
        Jason.encode!(%{directive_id: opts[:directive_id]}),
        Jason.encode!(%{effectiveness: effectiveness, snapshot_id: opts[:snapshot_id]})
      ]
    )
  end

  @doc "Reflexion 기록."
  def log_reflexion(entry) do
    run_query(
      """
      INSERT INTO sigma_v2_directive_audit
        (directive_id, tier, team, action, executed_at, outcome, principle_check_result)
      VALUES ($1, 0, $2, $3, NOW(), 'reflexion', $4)
      """,
      [
        Ecto.UUID.generate(),
        entry[:team] || "sigma",
        Jason.encode!(%{feedback_id: entry[:feedback_id]}),
        Jason.encode!(%{reflection: entry[:reflection], tags: entry[:tags]})
      ]
    )
  end

  @doc "팀의 최근 signal 목록 조회."
  def recent_signals(team, since_iso) do
    sql = """
    SELECT directive_id, action, executed_at, outcome, principle_check_result
    FROM sigma_v2_directive_audit
    WHERE team = $1
      AND outcome = 'signal_sent'
      AND executed_at > $2::timestamptz
    ORDER BY executed_at DESC
    LIMIT 50
    """

    case TeamJay.Repo.query(sql, [team, since_iso]) do
      {:ok, %{rows: rows, columns: cols}} ->
        atom_cols = Enum.map(cols, &String.to_atom/1)
        Enum.map(rows, &(Enum.zip(atom_cols, &1) |> Map.new()))

      _ ->
        []
    end
  rescue
    _ -> []
  end

  @doc "Signal 수용 카운트 기록 (Tier 1 acceptance)."
  def record_acceptance(signal_id) do
    run_query(
      """
      UPDATE sigma_v2_directive_audit
      SET principle_check_result = principle_check_result || $1::jsonb
      WHERE principle_check_result->>'signal_id' = $2
      """,
      [Jason.encode!(%{accepted: true, accepted_at: DateTime.utc_now() |> DateTime.to_iso8601()}), signal_id]
    )
  end

  @doc "팀+피드백타입 조합의 Tier 0 관찰 횟수 조회."
  def observation_count(team, _feedback_type) do
    sql = """
    SELECT COUNT(*)::int FROM sigma_v2_directive_audit
    WHERE team = $1 AND outcome = 'observed'
    """

    case TeamJay.Repo.query(sql, [team]) do
      {:ok, %{rows: [[count]]}} -> count
      _ -> 0
    end
  rescue
    _ -> 0
  end

  # ---

  defp run_query(sql, params) do
    case TeamJay.Repo.query(sql, params) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  rescue
    e -> {:error, e}
  end
end
