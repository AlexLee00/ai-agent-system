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
      (directive_id, tier, team, action, enqueued_at, status)
    VALUES ($1, $2, $3, $4::jsonb, NOW(), 'pending')
    """

    case Jay.Core.Repo.query(sql, [
           directive_id,
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
    case Jay.Core.Repo.query("SELECT COUNT(*)::int FROM sigma_v2_mailbox WHERE status = 'pending'", []) do
      {:ok, %{rows: [[count]]}} -> count
      _ -> 0
    end
  rescue
    _ -> 0
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
    SET status = 'approved', action = $1::jsonb, resolved_at = NOW()
    WHERE directive_id = $2
    """

    case Jay.Core.Repo.query(sql, [Jason.encode!(patch_action), directive_id]) do
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
    SET status = $1, resolved_at = NOW()
    WHERE directive_id = $2
    """

    case Jay.Core.Repo.query(sql, [status, directive_id]) do
      {:ok, _} -> :ok
      {:error, reason} -> {:error, reason}
    end
  rescue
    e -> {:error, e}
  end
end
