defmodule Sigma.V2.Registry do
  @moduledoc """
  분석가 프롬프트 세대 관리 — sigma_analyst_prompts 테이블.
  Phase 4 E-SPL 진화 엔진에서 현재 operational 세대 조회/제안/승격.
  참조: bots/sigma/docs/PLAN.md §6 Phase 4
  """

  @doc "현재 operational 분석가 프롬프트 세대 조회."
  def current_prompts do
    sql = """
    SELECT name, system_prompt, generation, fitness_score, created_at
    FROM sigma_analyst_prompts
    WHERE status = 'operational'
    ORDER BY name, generation DESC
    """

    case TeamJay.Repo.query(sql, []) do
      {:ok, %{rows: rows, columns: cols}} ->
        atom_cols = Enum.map(cols, &String.to_atom/1)
        Enum.map(rows, &(Enum.zip(atom_cols, &1) |> Map.new()))

      _ ->
        []
    end
  rescue
    _ -> []
  end

  @doc "새 자식 세대를 'shadow' 상태로 저장."
  def propose_generation(offspring) when is_list(offspring) do
    Enum.each(offspring, fn child ->
      sql = """
      INSERT INTO sigma_analyst_prompts
        (name, system_prompt, generation, status, parents, created_at)
      VALUES ($1, $2, $3, 'shadow', $4, NOW())
      """

      TeamJay.Repo.query(sql, [
        child[:name] || child.name,
        child[:system_prompt] || child.system_prompt || "",
        child[:generation] || child.generation || 1,
        Jason.encode!(child[:parents] || child.parents || [])
      ])
    end)

    :ok
  rescue
    e -> {:error, e}
  end

  @doc "1주 shadow 검증 통과 시 operational 승격."
  def promote_to_operational(name, generation) do
    archive_sql = """
    UPDATE sigma_analyst_prompts
    SET status = 'archived'
    WHERE name = $1 AND status = 'operational'
    """

    promote_sql = """
    UPDATE sigma_analyst_prompts
    SET status = 'operational', promoted_at = NOW()
    WHERE name = $1 AND generation = $2
    """

    with {:ok, _} <- TeamJay.Repo.query(archive_sql, [name]),
         {:ok, _} <- TeamJay.Repo.query(promote_sql, [name, generation]) do
      :ok
    end
  rescue
    e -> {:error, e}
  end
end
