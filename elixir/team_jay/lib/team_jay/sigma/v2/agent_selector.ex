defmodule Sigma.V2.AgentSelector do
  @moduledoc """
  ε-greedy 기반 에이전트 선택. TS hiring-contract.ts:selectBestAgent() 포팅.
  DB agent.registry에서 role+team 조건으로 최적 에이전트 선택.
  """

  @epsilon 0.2

  @doc """
  role, team, task_hint, exclude_names 조건으로 최적 에이전트 선택.
  ε-greedy: epsilon 확률로 무작위 탐색, 나머지는 최고 점수 선택.
  """
  @spec select_best(String.t(), String.t(), String.t(), [String.t()]) ::
          {:ok, %{name: String.t(), score: float()}} | {:error, :no_candidate}
  def select_best(role, team, _task_hint, exclude_names) do
    candidates = fetch_candidates(role, team, exclude_names)

    case candidates do
      [] ->
        {:error, :no_candidate}

      [_ | _] ->
        selected =
          if :rand.uniform() < @epsilon do
            Enum.random(candidates)
          else
            Enum.max_by(candidates, & &1.score)
          end

        {:ok, selected}
    end
  end

  defp fetch_candidates(role, team, exclude_names) do
    sql = """
    SELECT name, score
    FROM agent.registry
    WHERE role = $1 AND team = $2 AND status = 'active'
    ORDER BY score DESC
    LIMIT 10
    """

    case TeamJay.Repo.query(sql, [role, team]) do
      {:ok, %{rows: rows, columns: cols}} ->
        atom_cols = Enum.map(cols, &String.to_atom/1)

        rows
        |> Enum.map(&(Enum.zip(atom_cols, &1) |> Map.new()))
        |> Enum.reject(&((&1[:name] || "") in exclude_names))

      _ ->
        []
    end
  rescue
    _ -> []
  end
end
