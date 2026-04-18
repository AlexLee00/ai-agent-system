defmodule Sigma.V2.AgentSelector do
  @moduledoc """
  UCB1 기반 에이전트 선택 (Phase M 고도화).

  기존 ε-greedy에서 UCB1 (Upper Confidence Bound) 알고리즘으로 업그레이드.
  시그마 고유 자산: ε-greedy 구조 유지 + UCB1 보너스 오버레이.

  선택 전략:
  - SIGMA_UCB_ENABLED=true: UCB1 score = avg_reward + C * sqrt(ln(N) / n_i)
  - SIGMA_UCB_ENABLED=false (기본): ε-greedy fallback (기존 동작)

  ε-greedy는 탐색 20%를 고정값으로 처리하지만 UCB1은 탐색을 동적으로 조정.
  탐색 횟수(n_i)가 적을수록 UCB1 보너스가 커져 새 에이전트를 자동 탐색.

  참조: Auer et al. (2002) "Finite-time analysis of the multi-armed bandit"
  """

  @epsilon 0.2
  @ucb_exploration_constant 1.414

  @doc """
  role, team, task_hint, exclude_names 조건으로 최적 에이전트 선택.
  UCB1 활성 시 UCB1 점수로 선택, 비활성 시 ε-greedy fallback.
  """
  @spec select_best(String.t(), String.t(), String.t(), [String.t()]) ::
          {:ok, %{name: String.t(), score: float()}} | {:error, :no_candidate}
  def select_best(role, team, task_hint, exclude_names) do
    candidates = fetch_candidates_with_history(role, team, exclude_names)

    case candidates do
      [] ->
        {:error, :no_candidate}

      [_ | _] ->
        selected =
          if ucb_enabled?() do
            total_n = Enum.sum(Enum.map(candidates, & &1.selection_count))
            ucb_select(candidates, total_n)
          else
            epsilon_greedy_select(candidates)
          end

        record_selection(selected, role, team, task_hint)

        {:ok, %{name: selected.name, score: selected.score}}
    end
  end

  @doc "Pod.Performance에서 스코어 업데이트 시 호출."
  @spec update_score(String.t(), float(), integer()) :: :ok
  def update_score(agent_name, accuracy, _total_successes) do
    sql = """
    UPDATE agent.registry
    SET score = $1
    WHERE name = $2
    """

    Jay.Core.Repo.query(sql, [accuracy * 10.0, agent_name])
    :ok
  rescue
    e ->
      require Logger
      Logger.warning("[Sigma.V2.AgentSelector] update_score 실패: #{inspect(e)}")
      :ok
  end

  # ─────────────────────────────────────────────────
  # Private — 선택 알고리즘
  # ─────────────────────────────────────────────────

  defp ucb_select(candidates, total_n) do
    log_n = :math.log(max(total_n, 1))

    candidates
    |> Enum.max_by(fn c ->
      avg_reward = c.score / 10.0
      n_i = max(c.selection_count, 1)
      ucb_bonus = @ucb_exploration_constant * :math.sqrt(log_n / n_i)
      avg_reward + ucb_bonus
    end)
  end

  defp epsilon_greedy_select(candidates) do
    if :rand.uniform() < @epsilon do
      Enum.random(candidates)
    else
      Enum.max_by(candidates, & &1.score)
    end
  end

  # ─────────────────────────────────────────────────
  # Private — DB 조회/기록
  # ─────────────────────────────────────────────────

  defp fetch_candidates_with_history(role, team, exclude_names) do
    sql = """
    SELECT r.name, r.score,
           COALESCE(h.selection_count, 0) AS selection_count,
           COALESCE(h.success_count, 0) AS success_count
    FROM agent.registry r
    LEFT JOIN sigma_agent_selector_history h ON h.agent_name = r.name
    WHERE r.role = $1 AND r.team = $2 AND r.status = 'active'
    ORDER BY r.score DESC
    LIMIT 10
    """

    case Jay.Core.Repo.query(sql, [role, team]) do
      {:ok, %{rows: rows, columns: cols}} ->
        atom_cols = Enum.map(cols, &String.to_atom/1)

        rows
        |> Enum.map(&(Enum.zip(atom_cols, &1) |> Map.new()))
        |> Enum.reject(&((&1[:name] || "") in exclude_names))
        |> Enum.map(fn r ->
          %{
            name: r[:name],
            score: to_float(r[:score]),
            selection_count: to_int(r[:selection_count]),
            success_count: to_int(r[:success_count])
          }
        end)

      _ ->
        []
    end
  rescue
    _ -> []
  end

  defp record_selection(%{name: name}, role, team, task_hint) do
    sql = """
    INSERT INTO sigma_agent_selector_history
      (agent_name, role, team, task_hint, selected_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (agent_name) DO UPDATE
      SET selection_count = sigma_agent_selector_history.selection_count + 1,
          last_selected_at = NOW()
    """

    Jay.Core.Repo.query(sql, [name, role, team, task_hint])
    :ok
  rescue
    _ -> :ok
  end

  defp ucb_enabled? do
    System.get_env("SIGMA_UCB_ENABLED") == "true"
  end

  defp to_float(v) when is_float(v), do: v
  defp to_float(v) when is_integer(v), do: v * 1.0
  defp to_float(_), do: 0.0

  defp to_int(nil), do: 0
  defp to_int(v) when is_integer(v), do: v
  defp to_int(v) when is_float(v), do: round(v)
  defp to_int(_), do: 0
end
