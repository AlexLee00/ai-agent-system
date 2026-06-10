defmodule Sigma.V2.Mailbox do
  @moduledoc """
  Tier 3 Directive 대기열 — Phase 2는 적재만, Phase 4에서 처리.
  sigma_v2_mailbox 테이블 사용.
  참조: bots/sigma/docs/PLAN.md §6 Phase 2
  """

  @doc "Tier 3 Directive 대기열 추가."
  def enqueue(directive) do
    directive_id = Ecto.UUID.generate()

    sql = """
    INSERT INTO sigma_v2_mailbox
      (directive_id, tier, team, action, enqueued_at, status, inserted_at, updated_at)
    VALUES ($1::uuid, $2, $3, $4::jsonb, NOW(), 'pending', NOW(), NOW())
    """

    case Jay.Core.Repo.query(sql, [
           uuid_param(directive_id),
           directive.tier,
           directive.team,
           Jason.encode!(directive.action)
         ]) do
      {:ok, _} -> {:ok, directive_id}
      {:error, reason} -> {:error, reason}
    end
  rescue
    e -> {:error, e}
  end

  @doc "대기 중인 Directive 목록 조회."
  def pending_items(opts \\ []) do
    limit = Keyword.get(opts, :limit, 20)

    sql = """
    SELECT id, directive_id, tier, team, action, enqueued_at, status
    FROM sigma_v2_mailbox
    WHERE status = 'pending'
    ORDER BY enqueued_at ASC
    LIMIT $1
    """

    case Jay.Core.Repo.query(sql, [limit]) do
      {:ok, %{rows: rows, columns: cols}} ->
        atom_cols = Enum.map(cols, &String.to_atom/1)
        Enum.map(rows, &(Enum.zip(atom_cols, &1) |> Map.new()))

      _ ->
        []
    end
  rescue
    _ -> []
  end

  @doc "대기 중인 Directive 수 조회."
  def pending_count do
    case Jay.Core.Repo.query(
           "SELECT COUNT(*)::int FROM sigma_v2_mailbox WHERE status = 'pending'",
           []
         ) do
      {:ok, %{rows: [[count]]}} -> count
      _ -> 0
    end
  rescue
    _ -> 0
  end

  @doc "장기 pending Directive 요약. 런타임 health가 대기열 정체를 놓치지 않도록 별도 신호로 노출한다."
  def stale_pending_summary(max_age_hours \\ 24) do
    hours =
      max_age_hours
      |> safe_int(24)
      |> max(1)

    sql = """
    SELECT COUNT(*)::int, MIN(enqueued_at)
    FROM sigma_v2_mailbox
    WHERE status = 'pending'
      AND enqueued_at < NOW() - ($1::int * INTERVAL '1 hour')
    """

    case Jay.Core.Repo.query(sql, [hours]) do
      {:ok, %{rows: [[count, oldest]]}} ->
        %{
          count: count || 0,
          oldest_enqueued_at: format_timestamp(oldest),
          max_age_hours: hours,
          status: if((count || 0) > 0, do: "stale_pending", else: "ok")
        }

      _ ->
        %{count: 0, oldest_enqueued_at: nil, max_age_hours: hours, status: "unknown"}
    end
  rescue
    _ -> %{count: 0, oldest_enqueued_at: nil, max_age_hours: safe_int(max_age_hours, 24), status: "unknown"}
  end

  @doc "Tier 3 Directive 승인 실행."
  def execute(directive_id) do
    update_status(directive_id, "approved")
  end

  @doc "Tier 3 Directive 거부."
  def reject(directive_id, _user) do
    update_status(directive_id, "rejected")
  end

  @doc "수정 후 Tier 3 Directive 실행."
  def execute_with_patch(directive_id, patch_action) do
    sql = """
    UPDATE sigma_v2_mailbox
    SET status = 'approved', action = $1::jsonb, resolved_at = NOW(), updated_at = NOW()
    WHERE directive_id = $2::uuid
    """

    case Jay.Core.Repo.query(sql, [Jason.encode!(patch_action), uuid_param(directive_id)]) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  rescue
    e -> {:error, e}
  end

  # ---

  defp update_status(directive_id, status) do
    sql = """
    UPDATE sigma_v2_mailbox
    SET status = $1, resolved_at = NOW(), updated_at = NOW()
    WHERE directive_id = $2::uuid
    """

    case Jay.Core.Repo.query(sql, [status, uuid_param(directive_id)]) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  rescue
    e -> {:error, e}
  end

  defp uuid_param(<<_::128>> = uuid), do: uuid

  defp uuid_param(value) when is_binary(value) do
    case Ecto.UUID.dump(value) do
      {:ok, uuid} -> uuid
      :error -> value
    end
  end

  defp uuid_param(value), do: value

  defp safe_int(value, _fallback) when is_integer(value), do: value

  defp safe_int(value, fallback) do
    case Integer.parse(to_string(value || "")) do
      {parsed, _} -> parsed
      _ -> fallback
    end
  rescue
    _ -> fallback
  end

  defp format_timestamp(nil), do: nil
  defp format_timestamp(%NaiveDateTime{} = value), do: NaiveDateTime.to_iso8601(value)
  defp format_timestamp(%DateTime{} = value), do: DateTime.to_iso8601(value)
  defp format_timestamp(value), do: to_string(value)
end
