defmodule Sigma.V2.SelfRewarding do
  @moduledoc """
  시그마팀 Self-Rewarding DPO 모듈 (arXiv 2401.10020 영감).

  LLM-as-a-Judge 기반 자기 보상 학습:
  - 사이클별 Directive 효과를 LLM이 자체 평가 (0.0~1.0)
  - DPO 선호 쌍 생성: preferred (≥ 0.7) vs rejected (≤ 0.4)
  - sigma_dpo_preference_pairs 테이블 저장
  - 주간 미평가 Directive 일괄 평가
  - 월간 분석가별 preferred_ratio ≤ 0.3이면 Telegram 알림 (자동 변경 금지)

  Kill Switch: SIGMA_SELF_REWARDING_ENABLED=true
  """

  require Logger

  @preferred_threshold 0.7
  @rejected_threshold 0.4
  @week_eval_limit 50

  # ─────────────────────────────────────────────────
  # 공개 API
  # ─────────────────────────────────────────────────

  @doc """
  단일 사이클 Self-Rewarding 평가.
  Kill switch OFF 또는 LLM/DB 오류 시 :ok 반환 (무해 실패).
  """
  @spec evaluate_cycle(map()) :: :ok | {:ok, map()}
  def evaluate_cycle(cycle_result) when is_map(cycle_result) do
    unless enabled?() do
      Logger.debug("[Sigma.V2.SelfRewarding] kill switch OFF — evaluate_cycle 스킵")
      :ok
    else
      do_evaluate(cycle_result)
    end
  end

  @doc "주간 평가 — MapeKLoop 주간 Knowledge 단계에서 호출."
  @spec evaluate_week() :: :ok
  def evaluate_week do
    unless enabled?(), do: :ok, else: do_evaluate_week()
  end

  @doc "월간 분석가별 preferred_ratio 분석 → 저성과 시 Telegram 알림."
  @spec rebalance_analyst_monthly() :: :ok
  def rebalance_analyst_monthly do
    unless enabled?(), do: :ok, else: do_rebalance()
  end

  # ─────────────────────────────────────────────────
  # Private — 평가 핵심 로직
  # ─────────────────────────────────────────────────

  defp do_evaluate(cycle_result) do
    metrics = build_metrics(cycle_result)

    case llm_judge(metrics) do
      {:ok, judgment} ->
        store_preference_pair(metrics, judgment)
        Logger.info("[Sigma.V2.SelfRewarding] cycle #{metrics.cycle_id} 평가 완료: score=#{judgment.score}, category=#{judgment.category}")
        {:ok, judgment}

      {:error, reason} ->
        Logger.warning("[Sigma.V2.SelfRewarding] LLM 평가 실패: #{inspect(reason)}")
        :ok
    end
  rescue
    e ->
      Logger.warning("[Sigma.V2.SelfRewarding] evaluate_cycle 오류: #{inspect(e)}")
      :ok
  end

  defp do_evaluate_week do
    sql = """
    SELECT cycle_id, date, analyst, team, success_count, error_count
    FROM sigma_v2_directive_audit
    WHERE executed_at > NOW() - INTERVAL '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM sigma_dpo_preference_pairs p
        WHERE p.cycle_id = sigma_v2_directive_audit.directive_id::text
      )
    ORDER BY executed_at DESC
    LIMIT #{@week_eval_limit}
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows, columns: cols}} ->
        cycles = rows_to_maps(rows, cols)
        Enum.each(cycles, fn c -> do_evaluate(c) end)
        Logger.info("[Sigma.V2.SelfRewarding] 주간 평가 완료: #{length(cycles)}건")
        :ok

      _ ->
        Logger.debug("[Sigma.V2.SelfRewarding] 주간 평가 — DB 접근 불가 또는 미평가 없음")
        :ok
    end
  rescue
    e ->
      Logger.warning("[Sigma.V2.SelfRewarding] evaluate_week 오류: #{inspect(e)}")
      :ok
  end

  defp do_rebalance do
    sql = """
    SELECT
      analyst,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE category = 'preferred') AS preferred_count
    FROM sigma_dpo_preference_pairs
    WHERE inserted_at > NOW() - INTERVAL '30 days'
    GROUP BY analyst
    HAVING COUNT(*) >= 10
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Enum.each(rows, fn [analyst, total, preferred_count] ->
          preferred_ratio = if total > 0, do: preferred_count / total, else: 0.0

          if preferred_ratio <= 0.3 do
            notify_poor_performance(analyst, preferred_ratio, preferred_count, total)
          end
        end)
        :ok

      _ ->
        Logger.debug("[Sigma.V2.SelfRewarding] rebalance — DB 접근 불가 또는 데이터 부족")
        :ok
    end
  rescue
    e ->
      Logger.warning("[Sigma.V2.SelfRewarding] rebalance_analyst_monthly 오류: #{inspect(e)}")
      :ok
  end

  # ─────────────────────────────────────────────────
  # Private — LLM 평가
  # ─────────────────────────────────────────────────

  defp llm_judge(metrics) do
    prompt = """
    당신은 엄격한 메타 코칭 심사관입니다.

    [시그마 MAPE-K 사이클 정보]
    - Cycle ID: #{metrics.cycle_id}
    - 날짜: #{metrics.date}
    - 분석가: #{metrics.analyst}
    - 대상 팀: #{metrics.team}

    [Directive 실행 성과]
    - 성공 Directive: #{metrics.success_count}건
    - 실패 Directive: #{metrics.error_count}건
    - Tier2 자동 적용: #{metrics.tier2_applied}건
    - 팀 수락률: #{metrics.acceptance_rate}

    [평가 기준]
    1. 이 사이클의 Directive 품질이 시스템 개선에 기여했는가? (0.0~1.0)
    2. 분석가 판단이 적절했는가? 편향이 없었는가?
    3. 원칙(P-001~P-031) 위반 없이 자율적으로 완수했는가?
    4. 개선해야 할 점은 무엇인가?

    반드시 아래 JSON 형식으로만 답하세요:
    {"score": 0.75, "critique": "...", "improvements": ["...", "..."]}

    score는 0.0~1.0 사이 숫자.
    """

    case Sigma.V2.LLM.Selector.call_with_fallback(:reflexion, prompt, max_tokens: 500) do
      {:ok, %{response: content}} when is_binary(content) -> parse_judgment(content)
      {:error, reason} -> {:error, reason}
    end
  end

  defp parse_judgment(content) when is_binary(content) do
    case Regex.run(~r/\{[^{}]*"score"[^{}]*\}/s, content) do
      [json_str] ->
        case Jason.decode(json_str) do
          {:ok, decoded} ->
            score = Map.get(decoded, "score", 0.5) |> to_float()
            {:ok, %{
              score: score,
              critique: Map.get(decoded, "critique", ""),
              improvements: Map.get(decoded, "improvements", []),
              category: classify(score)
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

  # ─────────────────────────────────────────────────
  # Private — DB 저장
  # ─────────────────────────────────────────────────

  defp store_preference_pair(metrics, judgment) do
    sql = """
    INSERT INTO sigma_dpo_preference_pairs
      (cycle_id, date, analyst, team, metrics, score, critique, improvements, category, inserted_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, NOW())
    ON CONFLICT (cycle_id) DO NOTHING
    """

    Jay.Core.Repo.query(sql, [
      to_string(metrics.cycle_id),
      metrics.date,
      metrics.analyst,
      metrics.team,
      Jason.encode!(metrics),
      judgment.score,
      judgment.critique,
      Jason.encode!(judgment.improvements),
      judgment.category
    ])

    :ok
  rescue
    e ->
      Logger.warning("[Sigma.V2.SelfRewarding] 선호 쌍 저장 실패: #{inspect(e)}")
      :ok
  end

  defp notify_poor_performance(analyst, preferred_ratio, preferred, total) do
    ratio_str = :erlang.float_to_binary(preferred_ratio * 1.0, decimals: 2)
    msg = "시그마 분석가 #{analyst} 성과 저하: preferred #{ratio_str} (#{preferred}/#{total}건). ESPL 진화 또는 프롬프트 재조정 권장. (자동 변경 없음)"

    try do
      Sigma.V2.TelegramReporter.on_meta_change("self_rewarding_alert", %{
        analyst: analyst,
        preferred_ratio: ratio_str,
        sample_size: total
      })
    rescue
      _ ->
        Logger.warning("[Sigma.V2.SelfRewarding] Telegram 알림 실패 — #{msg}")
    end
  end

  # ─────────────────────────────────────────────────
  # Private — 헬퍼
  # ─────────────────────────────────────────────────

  defp build_metrics(cycle_result) do
    get = fn key, default ->
      Map.get(cycle_result, key) || Map.get(cycle_result, to_string(key)) || default
    end

    results = get.(:results, [])
    success_count = Enum.count(results, &(Map.get(&1, :status) == :ok))
    error_count = Enum.count(results, &(Map.get(&1, :status) == :error))
    tier2_applied = Enum.count(results, &(get_in(&1, [:feedback, :tier]) == 2 and Map.get(&1, :status) == :ok))
    total = max(length(results), 1)

    %{
      cycle_id:        get.(:cycle_id, "unknown"),
      date:            get.(:date, Date.to_iso8601(Date.utc_today())),
      analyst:         get.(:analyst, "commander"),
      team:            get.(:team, "all"),
      success_count:   success_count,
      error_count:     error_count,
      tier2_applied:   tier2_applied,
      acceptance_rate: Float.round(success_count / total * 1.0, 2)
    }
  end

  defp rows_to_maps(rows, columns) do
    Enum.map(rows, fn row ->
      Enum.zip(columns, row)
      |> Map.new(fn {k, v} -> {String.to_atom(k), v} end)
    end)
  end

  defp enabled?, do: System.get_env("SIGMA_SELF_REWARDING_ENABLED") == "true"

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
