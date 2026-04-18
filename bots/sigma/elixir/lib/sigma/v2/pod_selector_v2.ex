defmodule Sigma.V2.PodSelectorV2 do
  @moduledoc """
  Pod 동적 편성 v2 — Multi-Armed Bandit 고도화 (Phase P).

  기존 AgentSelector(ε-greedy + UCB1)는 분석가(analyst) 선택에 사용.
  PodSelectorV2는 3 Pod(Trend/Growth/Risk) 자체 선택에 특화.

  전략 레이어:
  - Level 1: ε-greedy 20% 탐색 (기존 유지)
  - Level 2: UCB1 — 탐색/활용 균형
  - Level 3: Thompson Sampling — 베이지안 확률 탐색
  - Level 4: Contextual — 상황 유사도 기반 선택

  Kill Switch: SIGMA_POD_DYNAMIC_V2_ENABLED=true (기본 false → ε-greedy fallback)
  """

  require Logger

  @epsilon 0.2
  @ucb1_c 1.414
  @pods ~w(trend growth risk)
  @context_query_limit 20

  # ─────────────────────────────────────────────────
  # 공개 API
  # ─────────────────────────────────────────────────

  @doc """
  대상 팀과 컨텍스트에 따라 최적 Pod 선택.

  strategy 옵션: :ucb1 | :thompson | :contextual | :epsilon_greedy
  기본값: Kill switch OFF → :epsilon_greedy, ON → :ucb1
  """
  @spec select_best_pod(String.t(), map()) :: {:ok, String.t()} | {:error, term()}
  def select_best_pod(target_team, context \\ %{}) do
    if enabled?() do
      strategy = Map.get(context, :strategy, :ucb1)
      stats = fetch_bandit_stats(target_team)

      result =
        case strategy do
          :thompson -> select_thompson_sampling(stats, target_team)
          :contextual -> select_contextual(stats, context, target_team)
          :epsilon_greedy -> select_epsilon_greedy(stats)
          _ -> select_ucb1(stats, target_team)
        end

      case result do
        {:ok, pod} ->
          log_selection(pod, target_team, strategy, context)
          {:ok, pod}

        err ->
          err
      end
    else
      select_epsilon_greedy(fetch_bandit_stats(target_team))
    end
  end

  @doc "사이클 완료 후 Pod 보상 업데이트."
  @spec update_reward(String.t(), String.t(), float()) :: :ok
  def update_reward(pod_name, target_team, reward) when pod_name in @pods do
    sql = """
    INSERT INTO sigma_pod_bandit_stats (pod_name, target_team, trials, successes, failures, total_reward, avg_reward, last_selection_at, updated_at)
    VALUES ($1, $2, 1, $3, $4, $5, $5, NOW(), NOW())
    ON CONFLICT (pod_name, target_team) DO UPDATE SET
      trials = sigma_pod_bandit_stats.trials + 1,
      successes = sigma_pod_bandit_stats.successes + $3,
      failures = sigma_pod_bandit_stats.failures + $4,
      total_reward = sigma_pod_bandit_stats.total_reward + $5,
      avg_reward = (sigma_pod_bandit_stats.total_reward + $5) / (sigma_pod_bandit_stats.trials + 1),
      last_selection_at = NOW(),
      updated_at = NOW()
    """

    success_inc = if reward >= 0.5, do: 1, else: 0
    failure_inc = 1 - success_inc

    Jay.Core.Repo.query(sql, [pod_name, target_team, success_inc, failure_inc, reward])
    :ok
  rescue
    e ->
      Logger.warning("[Sigma.V2.PodSelectorV2] update_reward 실패: #{inspect(e)}")
      :ok
  end

  @doc "지난 N일간 Pod별 bandit 통계 조회."
  @spec pod_stats(String.t(), integer()) :: list()
  def pod_stats(target_team, _days \\ 30) do
    sql = """
    SELECT pod_name, trials, successes, failures, avg_reward, last_selection_at
    FROM sigma_pod_bandit_stats
    WHERE target_team = $1
    ORDER BY avg_reward DESC
    """

    case Jay.Core.Repo.query(sql, [target_team]) do
      {:ok, %{rows: rows, columns: cols}} -> rows_to_maps(rows, cols)
      _ -> []
    end
  rescue
    _ -> []
  end

  # ─────────────────────────────────────────────────
  # Private — 선택 알고리즘
  # ─────────────────────────────────────────────────

  defp select_ucb1(stats, _target_team) do
    total_trials = stats |> Enum.map(& &1.trials) |> Enum.sum() |> max(1)
    log_n = :math.log(total_trials)

    scored =
      Enum.map(all_pods_with_defaults(stats), fn pod ->
        exploitation = pod.avg_reward
        n_i = max(pod.trials, 1)
        exploration = @ucb1_c * :math.sqrt(log_n / n_i)
        Map.put(pod, :ucb_score, exploitation + exploration)
      end)

    selected = Enum.max_by(scored, & &1.ucb_score)
    Logger.debug("[Sigma.V2.PodSelectorV2] UCB1 선택: #{selected.pod_name} (ucb=#{Float.round(selected.ucb_score, 3)})")
    {:ok, selected.pod_name}
  end

  defp select_thompson_sampling(stats, _target_team) do
    sampled =
      Enum.map(all_pods_with_defaults(stats), fn pod ->
        alpha = pod.successes + 1
        beta = pod.failures + 1
        sample = sample_beta(alpha, beta)
        Map.put(pod, :thompson_sample, sample)
      end)

    selected = Enum.max_by(sampled, & &1.thompson_sample)
    Logger.debug("[Sigma.V2.PodSelectorV2] Thompson 선택: #{selected.pod_name} (sample=#{Float.round(selected.thompson_sample, 3)})")
    {:ok, selected.pod_name}
  end

  defp select_contextual(stats, context, target_team) do
    past_successes = fetch_past_successes(target_team)

    scored =
      Enum.map(all_pods_with_defaults(stats), fn pod ->
        pod_past = Enum.filter(past_successes, &(&1.pod_name == pod.pod_name))

        context_score =
          if pod_past == [] do
            pod.avg_reward
          else
            ctx_sim = context_similarity(context, pod_past)
            recency_weight = compute_recency_weight(pod_past)
            ctx_sim * recency_weight
          end

        Map.put(pod, :context_score, context_score)
      end)

    selected = Enum.max_by(scored, & &1.context_score)
    Logger.debug("[Sigma.V2.PodSelectorV2] Contextual 선택: #{selected.pod_name} (score=#{Float.round(selected.context_score, 3)})")
    {:ok, selected.pod_name}
  end

  defp select_epsilon_greedy(stats) do
    if :rand.uniform() < @epsilon do
      pod = Enum.random(@pods)
      Logger.debug("[Sigma.V2.PodSelectorV2] ε-greedy 탐색: #{pod}")
      {:ok, pod}
    else
      case all_pods_with_defaults(stats) |> Enum.max_by(& &1.avg_reward) do
        %{pod_name: pod} ->
          Logger.debug("[Sigma.V2.PodSelectorV2] ε-greedy 활용: #{pod}")
          {:ok, pod}

        _ ->
          {:ok, "trend"}
      end
    end
  end

  # ─────────────────────────────────────────────────
  # Private — Thompson Sampling Beta 분포 샘플링
  # ─────────────────────────────────────────────────

  # Beta(α, β) 분포에서 샘플링 — Johnk's method
  defp sample_beta(alpha, beta) do
    u = :rand.uniform()
    v = :rand.uniform()

    x = :math.pow(u, 1.0 / alpha)
    y = :math.pow(v, 1.0 / beta)

    if x + y > 0 do
      x / (x + y)
    else
      0.5
    end
  end

  # ─────────────────────────────────────────────────
  # Private — Contextual Similarity
  # ─────────────────────────────────────────────────

  defp context_similarity(context, past_records) do
    ctx_keys = ~w(target_team time_of_day weekday urgency)

    similarities =
      Enum.map(past_records, fn rec ->
        past_ctx = Map.get(rec, :context) || %{}

        matched =
          Enum.count(ctx_keys, fn k ->
            Map.get(context, String.to_atom(k)) == Map.get(past_ctx, k) ||
              Map.get(context, k) == Map.get(past_ctx, k)
          end)

        success_weight = if rec.actual_reward && rec.actual_reward >= 0.5, do: 1.0, else: 0.3
        matched / length(ctx_keys) * success_weight
      end)

    if similarities == [], do: 0.5, else: Enum.sum(similarities) / length(similarities)
  end

  defp compute_recency_weight(past_records) do
    now_unix = DateTime.utc_now() |> DateTime.to_unix()

    weights =
      Enum.map(past_records, fn rec ->
        selected_at = rec.selected_at

        age_hours =
          if selected_at do
            dt = if is_binary(selected_at), do: DateTime.from_iso8601(selected_at) |> elem(1), else: selected_at
            max(0, (now_unix - DateTime.to_unix(dt)) / 3600)
          else
            168
          end

        :math.exp(-age_hours / 168.0)
      end)

    if weights == [], do: 1.0, else: Enum.sum(weights) / length(weights)
  end

  # ─────────────────────────────────────────────────
  # Private — DB 헬퍼
  # ─────────────────────────────────────────────────

  defp fetch_bandit_stats(target_team) do
    sql = """
    SELECT pod_name, trials, successes, failures, avg_reward
    FROM sigma_pod_bandit_stats
    WHERE target_team = $1
    """

    case Jay.Core.Repo.query(sql, [target_team]) do
      {:ok, %{rows: rows, columns: cols}} -> rows_to_maps(rows, cols)
      _ -> []
    end
  rescue
    _ -> []
  end

  defp fetch_past_successes(target_team) do
    sql = """
    SELECT pod_name, context, actual_reward, selected_at
    FROM sigma_pod_selection_log
    WHERE target_team = $1
      AND feedback_received_at IS NOT NULL
    ORDER BY selected_at DESC
    LIMIT #{@context_query_limit}
    """

    case Jay.Core.Repo.query(sql, [target_team]) do
      {:ok, %{rows: rows, columns: cols}} -> rows_to_maps(rows, cols)
      _ -> []
    end
  rescue
    _ -> []
  end

  defp log_selection(pod_name, target_team, strategy, context) do
    try do
      strategy_str = to_string(strategy)
      ctx_json = case Jason.encode(context) do
        {:ok, json} -> json
        _ -> "{}"
      end

      sql = """
      INSERT INTO sigma_pod_selection_log (pod_name, target_team, strategy, context, selected_at)
      VALUES ($1, $2, $3, $4::jsonb, NOW())
      """

      Jay.Core.Repo.query(sql, [pod_name, target_team, strategy_str, ctx_json])
      :ok
    rescue
      _ -> :ok
    end
  end

  defp all_pods_with_defaults(stats) do
    Enum.map(@pods, fn pod ->
      existing = Enum.find(stats, &(&1.pod_name == pod))

      existing ||
        %{
          pod_name: pod,
          trials: 0,
          successes: 1,
          failures: 1,
          avg_reward: 0.5
        }
    end)
  end

  defp rows_to_maps(rows, cols) do
    Enum.map(rows, fn row ->
      Enum.zip(cols, row)
      |> Map.new(fn {k, v} -> {String.to_atom(k), v} end)
    end)
  end

  defp enabled? do
    System.get_env("SIGMA_POD_DYNAMIC_V2_ENABLED") == "true"
  end
end
