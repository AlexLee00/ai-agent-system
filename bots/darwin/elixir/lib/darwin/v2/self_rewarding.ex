defmodule Darwin.V2.SelfRewarding do
  @moduledoc """
  다윈팀 Self-Rewarding DPO 모듈 (Phase S).

  LLM-as-a-Judge 기반 자기 보상 학습 (arXiv 2401.10020 영감):
  - 사이클별 성과를 LLM이 자체 평가 (0.0~1.0)
  - DPO 선호 쌍 생성: preferred (score ≥ 0.7) vs rejected (score ≤ 0.4)
  - darwin_dpo_preference_pairs 테이블 저장
  - 주간 미평가 사이클 일괄 평가
  - 월간 Recommender 성과 분석 → Telegram 알림 (자동 변경 금지)

  Kill Switch: DARWIN_SELF_REWARDING_ENABLED=true
  """

  require Logger

  @preferred_threshold 0.7
  @rejected_threshold 0.4
  @week_eval_limit 50

  # ──────────────────────────────────────────────
  # 공개 API
  # ──────────────────────────────────────────────

  @doc """
  단일 사이클 Self-Rewarding 평가.

  cycle_or_id: cycle_result 맵 또는 cycle_id 문자열/정수.
  Kill switch OFF 또는 LLM/DB 오류 시 :ok 반환 (무해 실패).
  """
  @spec evaluate_cycle(map() | binary() | integer()) :: :ok | {:ok, map()}
  def evaluate_cycle(cycle_or_id) do
    unless Darwin.V2.KillSwitch.enabled?(:self_rewarding) do
      Logger.debug("[Darwin.V2.SelfRewarding] kill switch OFF — evaluate_cycle 스킵")
      :ok
    else
      do_evaluate(normalize_cycle(cycle_or_id))
    end
  end

  @doc """
  주간 평가 — MapeKLoop에서 일요일 호출.
  지난 7일 미평가 사이클 darwin_dpo_preference_pairs에 없는 것 일괄 처리.
  """
  @spec evaluate_week() :: :ok
  def evaluate_week do
    unless Darwin.V2.KillSwitch.enabled?(:self_rewarding) do
      :ok
    else
      do_evaluate_week()
    end
  end

  @doc """
  월간 Recommender affinity 분석.
  최근 30일 DPO 선호 쌍 집계 → preferred_ratio ≤ 0.3이면 Telegram 알림.
  자동 모델 변경 금지 — 알림만 발송.
  """
  @spec rebalance_recommender_monthly() :: :ok
  def rebalance_recommender_monthly do
    unless Darwin.V2.KillSwitch.enabled?(:self_rewarding) do
      :ok
    else
      do_rebalance()
    end
  end

  # ──────────────────────────────────────────────
  # Private — 평가 핵심 로직
  # ──────────────────────────────────────────────

  defp do_evaluate(cycle_result) do
    metrics = build_metrics(cycle_result)

    case llm_judge(metrics) do
      {:ok, judgment} ->
        store_preference_pair(metrics, judgment)
        cycle_id = metrics.cycle_id
        Logger.info("[Darwin.V2.SelfRewarding] cycle #{cycle_id} 평가 완료: score=#{judgment.score}, category=#{judgment.category}")
        {:ok, judgment}

      {:error, reason} ->
        Logger.warning("[Darwin.V2.SelfRewarding] LLM 평가 실패: #{inspect(reason)}")
        :ok
    end
  rescue
    e ->
      Logger.warning("[Darwin.V2.SelfRewarding] evaluate_cycle 오류: #{inspect(e)}")
      :ok
  end

  defp do_evaluate_week do
    sql = """
    SELECT cycle_id, paper_title, stage, metrics
    FROM darwin_cycle_history
    WHERE inserted_at > NOW() - INTERVAL '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM darwin_dpo_preference_pairs p
        WHERE p.cycle_id = darwin_cycle_history.cycle_id
      )
    ORDER BY inserted_at DESC
    LIMIT #{@week_eval_limit}
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows, columns: cols}} ->
        cycles = rows_to_maps(rows, cols)
        Enum.each(cycles, fn c -> do_evaluate(c) end)
        Logger.info("[Darwin.V2.SelfRewarding] 주간 평가 완료: #{length(cycles)}건")
        :ok

      _ ->
        Logger.debug("[Darwin.V2.SelfRewarding] 주간 평가 — darwin_cycle_history 접근 불가 또는 미평가 없음")
        :ok
    end
  rescue
    e ->
      Logger.warning("[Darwin.V2.SelfRewarding] evaluate_week 오류: #{inspect(e)}")
      :ok
  end

  defp do_rebalance do
    sql = """
    SELECT
      stage AS agent,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE category = 'preferred') AS preferred_count
    FROM darwin_dpo_preference_pairs
    WHERE inserted_at > NOW() - INTERVAL '30 days'
    GROUP BY stage
    HAVING COUNT(*) >= 10
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Enum.each(rows, fn [agent, total, preferred_count] ->
          preferred_ratio = if total > 0, do: preferred_count / total, else: 0.0
          if preferred_ratio <= 0.3 do
            notify_poor_performance(agent, preferred_ratio, preferred_count, total)
          end
          log_recommender_history(agent, preferred_ratio, total)
        end)
        :ok

      _ ->
        Logger.debug("[Darwin.V2.SelfRewarding] rebalance — DB 접근 불가 또는 데이터 부족")
        :ok
    end
  rescue
    e ->
      Logger.warning("[Darwin.V2.SelfRewarding] rebalance_recommender_monthly 오류: #{inspect(e)}")
      :ok
  end

  # ──────────────────────────────────────────────
  # Private — LLM 평가
  # ──────────────────────────────────────────────

  defp llm_judge(metrics) do
    prompt = """
    당신은 엄격한 R&D 심사관입니다.

    [사이클 정보]
    - Cycle ID: #{metrics.cycle_id}
    - 논문: #{metrics.paper_title}
    - 단계: #{metrics.stage}
    - 소요 시간: #{metrics.duration_sec}초
    - LLM 비용: $#{metrics.llm_cost_usd}

    [성공 지표]
    - 논문 평가 점수: #{metrics.evaluation_score}/10
    - 구현 완료: #{metrics.implementation_success}
    - 검증 통과: #{metrics.verification_success}
    - 적용 여부: #{metrics.applied}
    - 원칙 위반: #{metrics.principle_violations}회

    [평가 기준]
    1. 이 사이클은 팀 제이 시스템 개선에 기여했는가? (0.0~1.0)
    2. LLM 비용 대비 효과가 적절한가?
    3. 원칙 위반 없이 자율적으로 완수했는가?
    4. 개선해야 할 점은 무엇인가?

    반드시 아래 JSON 형식으로만 답하세요:
    {"score": 0.75, "critique": "...", "improvements": ["...", "..."]}

    score는 0.0~1.0 사이 숫자.
    """

    case Darwin.V2.LLM.Selector.complete(
           "darwin.self_rewarding_judge",
           [%{role: "user", content: prompt}],
           max_tokens: 500,
           urgency: :low
         ) do
      {:ok, content} -> parse_judgment(content)
      {:error, reason} -> {:error, reason}
    end
  end

  defp parse_judgment(content) when is_binary(content) do
    case Regex.run(~r/\{[^{}]*"score"[^{}]*\}/s, content) do
      [json_str] ->
        case Jason.decode(json_str) do
          {:ok, decoded} ->
            score = Map.get(decoded, "score", 0.5) |> to_float()
            category = classify(score)
            {:ok, %{
              score: score,
              critique: Map.get(decoded, "critique", ""),
              improvements: Map.get(decoded, "improvements", []),
              category: category
            }}

          _ ->
            {:ok, neutral_judgment(content)}
        end

      _ ->
        {:ok, neutral_judgment(content)}
    end
  end

  defp neutral_judgment(critique),
    do: %{score: 0.5, critique: critique, improvements: [], category: "neutral"}

  defp classify(score) when score >= @preferred_threshold, do: "preferred"
  defp classify(score) when score <= @rejected_threshold, do: "rejected"
  defp classify(_), do: "neutral"

  # ──────────────────────────────────────────────
  # Private — DB 저장
  # ──────────────────────────────────────────────

  defp store_preference_pair(metrics, judgment) do
    sql = """
    INSERT INTO darwin_dpo_preference_pairs
      (cycle_id, paper_title, stage, metrics, score, critique, improvements, category, inserted_at)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, NOW())
    """

    Jay.Core.Repo.query(sql, [
      to_string(metrics.cycle_id),
      metrics.paper_title,
      metrics.stage,
      Jason.encode!(metrics),
      judgment.score,
      judgment.critique,
      Jason.encode!(judgment.improvements),
      judgment.category
    ])

    :ok
  rescue
    e ->
      Logger.warning("[Darwin.V2.SelfRewarding] 선호 쌍 저장 실패: #{inspect(e)}")
      :ok
  end

  defp log_recommender_history(agent, preferred_ratio, total) do
    sql = """
    INSERT INTO darwin_recommender_history
      (agent_name, llm_model, preferred_ratio, sample_size, changed_by, inserted_at)
    VALUES ($1, $2, $3, $4, 'auto', NOW())
    """

    Jay.Core.Repo.query(sql, [agent, "current", preferred_ratio, total])
    :ok
  rescue
    _ -> :ok
  end

  defp notify_poor_performance(agent, preferred_ratio, preferred, total) do
    ratio_str = :erlang.float_to_binary(preferred_ratio * 1.0, decimals: 2)
    msg = "Darwin #{agent} 성과 저하: preferred #{ratio_str} (#{preferred}/#{total}). LLM 모델 변경 검토 권장."

    try do
      Darwin.V2.TelegramBridge.notify(msg, :warning)
    rescue
      _ ->
        Logger.warning("[Darwin.V2.SelfRewarding] Telegram 알림 실패 — #{msg}")
    end
  end

  # ──────────────────────────────────────────────
  # Private — 헬퍼
  # ──────────────────────────────────────────────

  defp normalize_cycle(cycle_result) when is_map(cycle_result), do: cycle_result
  defp normalize_cycle(cycle_id), do: fetch_cycle_from_db(cycle_id)

  defp build_metrics(cycle_result) do
    get = fn key, default ->
      Map.get(cycle_result, key) || Map.get(cycle_result, to_string(key)) || default
    end

    %{
      cycle_id:                get.(:cycle_id, "unknown"),
      paper_title:             get.(:paper_title, "N/A"),
      stage:                   to_string(get.(:stage, "learn")),
      duration_sec:            get.(:duration_sec, 0),
      llm_cost_usd:            get.(:llm_cost_usd, 0.0),
      evaluation_score:        get.(:evaluation_score, 5.0),
      implementation_success:  get.(:implementation_success, false),
      verification_success:    get.(:verification_success, false),
      applied:                 get.(:applied, false),
      principle_violations:    get.(:principle_violations, 0)
    }
  end

  defp fetch_cycle_from_db(cycle_id) do
    sql = """
    SELECT cycle_id, paper_title, stage, metrics
    FROM darwin_cycle_history
    WHERE cycle_id = $1
    LIMIT 1
    """

    case Jay.Core.Repo.query(sql, [to_string(cycle_id)]) do
      {:ok, %{rows: [[id, title, stage, metrics]], columns: _}} ->
        base = %{cycle_id: id, paper_title: title, stage: stage}
        if is_map(metrics), do: Map.merge(base, metrics), else: base

      _ ->
        %{cycle_id: cycle_id}
    end
  rescue
    _ -> %{cycle_id: cycle_id}
  end

  defp rows_to_maps(rows, columns) do
    Enum.map(rows, fn row ->
      Enum.zip(columns, row)
      |> Map.new(fn {k, v} -> {String.to_atom(k), v} end)
    end)
  end

  defp to_float(v) when is_float(v), do: v
  defp to_float(v) when is_integer(v), do: v * 1.0
  defp to_float(v) when is_binary(v) do
    case Float.parse(v) do
      {f, _} -> f
      :error -> 0.5
    end
  end
  defp to_float(_), do: 0.5

end
