defmodule TeamJay.Ska.SelfRewarding do
  @moduledoc """
  스카팀 Self-Rewarding — 스킬 레벨 자율 학습.

  동작:
  1. 스킬 실행 결과 관찰 (ska_skill_execution_log)
  2. LLM-as-a-Judge: 성공/실패 판단 + 개선 방향
  3. 선호 쌍 축적 (preferred / rejected, ska_skill_preference_pairs)
  4. 월간 affinity 재조정 제안 (마스터 승인 필요)
  5. 반복 실패 스킬 → LLM 새 버전 제안 (마스터 승인 후 적용)

  Kill Switch: SKA_SELF_REWARDING_ENABLED=true (기본 false)
  """
  require Logger

  @rejected_threshold 0.4
  @rejection_trigger_count 10

  # ─── 공개 API ───────────────────────────────────────────

  @doc """
  스킬 실행 결과를 Self-Rewarding 평가.
  execution_id: ska_skill_execution_log.id
  """
  def evaluate_skill_execution(skill_name, execution_id) do
    unless enabled?() do
      {:error, :self_rewarding_disabled}
    else
      with {:ok, execution} <- fetch_execution(execution_id),
           {:ok, context} <- build_evaluation_context(skill_name, execution),
           {:ok, judgment} <- llm_judge(skill_name, execution, context),
           {:ok, _pair} <- store_preference_pair(skill_name, execution, judgment) do
        maybe_flag_for_improvement(skill_name, judgment)
        {:ok, judgment}
      end
    end
  end

  @doc """
  LLM 기반 스킬 개선 제안 — Telegram으로 마스터에 전달.
  자동 적용 없음. 반드시 마스터 승인 후 수동 적용.
  """
  def propose_skill_improvement(skill_name) do
    recent_failures = fetch_recent_failures(skill_name, 14)
    failure_count = length(recent_failures)

    if failure_count < 3 do
      {:error, :insufficient_failures}
    else
      prompt = build_improvement_prompt(skill_name, recent_failures)

      case call_llm(prompt) do
        {:ok, suggestion} ->
          notify_improvement_proposal(skill_name, failure_count, suggestion)
          {:ok, suggestion}

        {:error, reason} ->
          Logger.warning("[SelfRewarding] LLM 제안 실패: #{inspect(reason)}")
          {:error, reason}
      end
    end
  end

  @doc "월간 스킬 affinity 재조정 (마스터 승인 후 수동 적용)"
  def rebalance_skill_affinity_monthly do
    unless enabled?() do
      {:error, :self_rewarding_disabled}
    else
      sql = """
      SELECT skill_name,
             COUNT(*) AS total_pairs,
             SUM(CASE WHEN category = 'preferred' THEN 1 ELSE 0 END) AS preferred_count,
             SUM(CASE WHEN category = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
             ROUND(AVG(score)::numeric, 3) AS avg_score
      FROM ska_skill_preference_pairs
      WHERE inserted_at > NOW() - INTERVAL '30 days'
      GROUP BY skill_name
      ORDER BY avg_score ASC
      """

      case Jay.Core.Repo.query(sql, []) do
        {:ok, %{rows: rows, columns: cols}} ->
          data = Enum.map(rows, fn row -> Enum.zip(cols, row) |> Map.new() end)
          low_affinity = Enum.filter(data, fn s -> (s["avg_score"] || 1.0) < @rejected_threshold end)

          if low_affinity != [] do
            names = Enum.map_join(low_affinity, ", ", & &1["skill_name"])

            Jay.Core.HubClient.post_alarm(
              "⚠️ [SelfRewarding] 월간 affinity 하락 스킬: #{names} — 마스터 검토 필요",
              "ska",
              "self_rewarding"
            )
          end

          {:ok, data}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  # ─── 내부 함수 ──────────────────────────────────────────

  defp fetch_execution(execution_id) do
    sql = """
    SELECT id, skill_name, caller_agent, status, duration_ms,
           error_reason, input_summary, output_summary, inserted_at
    FROM ska_skill_execution_log
    WHERE id = $1
    """

    case Jay.Core.Repo.query(sql, [execution_id]) do
      {:ok, %{rows: [row], columns: cols}} ->
        {:ok, Enum.zip(cols, row) |> Map.new()}

      {:ok, %{rows: []}} ->
        {:error, :execution_not_found}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp build_evaluation_context(skill_name, execution) do
    sql = """
    SELECT
      ROUND(100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::numeric
            / NULLIF(COUNT(*), 0), 2) AS success_rate_pct,
      ROUND(AVG(duration_ms)::numeric, 2) AS avg_duration_ms,
      COUNT(*) AS similar_failures
    FROM ska_skill_execution_log
    WHERE skill_name = $1
      AND inserted_at > NOW() - INTERVAL '7 days'
    """

    case Jay.Core.Repo.query(sql, [to_string(skill_name)]) do
      {:ok, %{rows: [[rate, avg_ms, failures]]}} ->
        {:ok, %{
          recent_success_rate: rate || 100.0,
          avg_duration_ms: avg_ms || 0,
          similar_failures: failures || 0,
          execution_status: execution["status"]
        }}

      _ ->
        {:ok, %{recent_success_rate: 100.0, avg_duration_ms: 0, similar_failures: 0}}
    end
  end

  defp llm_judge(skill_name, execution, context) do
    prompt = """
    당신은 스카팀 스킬 품질 평가관입니다.

    [스킬 실행 결과]
    스킬: #{skill_name}
    호출자: #{execution["caller_agent"]}
    상태: #{execution["status"]}
    실행 시간: #{execution["duration_ms"]}ms
    오류: #{execution["error_reason"] || "없음"}

    [7일 성과 컨텍스트]
    성공률: #{context[:recent_success_rate]}%
    평균 실행 시간: #{context[:avg_duration_ms]}ms
    유사 실패 건수: #{context[:similar_failures]}

    아래 JSON 형식으로만 응답하세요:
    {
      "score": 0.0~1.0,
      "category": "preferred" | "rejected" | "neutral",
      "failure_cause": "internal" | "external" | "n/a",
      "critique": "한 줄 평가",
      "improvement_hint": "한 줄 개선 방향"
    }
    """

    call_llm(prompt)
  end

  defp store_preference_pair(skill_name, execution, judgment) do
    sql = """
    INSERT INTO ska_skill_preference_pairs
      (skill_name, caller_agent, execution_id, score,
       category, failure_cause, critique, improvement_hint, inserted_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    """

    args = [
      to_string(skill_name),
      execution["caller_agent"],
      execution["id"],
      judgment["score"] || 0.5,
      judgment["category"] || "neutral",
      judgment["failure_cause"] || "n/a",
      judgment["critique"] || "",
      judgment["improvement_hint"] || ""
    ]

    case Jay.Core.Repo.query(sql, args) do
      {:ok, _} -> {:ok, :stored}
      {:error, reason} -> {:error, reason}
    end
  end

  defp maybe_flag_for_improvement(skill_name, judgment) do
    if (judgment["score"] || 1.0) < @rejected_threshold do
      count = count_recent_rejections(skill_name)
      if count >= @rejection_trigger_count do
        Task.start(fn -> propose_skill_improvement(skill_name) end)
      end
    end
  end

  defp count_recent_rejections(skill_name) do
    sql = """
    SELECT COUNT(*) FROM ska_skill_preference_pairs
    WHERE skill_name = $1
      AND category = 'rejected'
      AND inserted_at > NOW() - INTERVAL '7 days'
    """

    case Jay.Core.Repo.query(sql, [to_string(skill_name)]) do
      {:ok, %{rows: [[count]]}} -> count || 0
      _ -> 0
    end
  end

  defp fetch_recent_failures(skill_name, days) do
    sql = """
    SELECT id, caller_agent, status, duration_ms, error_reason, inserted_at
    FROM ska_skill_execution_log
    WHERE skill_name = $1
      AND status = 'failure'
      AND inserted_at > NOW() - ($2 || ' days')::interval
    ORDER BY inserted_at DESC
    LIMIT 10
    """

    case Jay.Core.Repo.query(sql, [to_string(skill_name), days]) do
      {:ok, %{rows: rows, columns: cols}} ->
        Enum.map(rows, fn row -> Enum.zip(cols, row) |> Map.new() end)

      _ ->
        []
    end
  end

  defp build_improvement_prompt(skill_name, failures) do
    failure_summary =
      failures
      |> Enum.take(5)
      |> Enum.map_join("\n", fn f ->
        "  - #{f["inserted_at"]} #{f["caller_agent"]}: #{f["error_reason"]}"
      end)

    """
    스카팀 스킬 #{skill_name} 이 최근 #{length(failures)}건 실패 패턴을 보입니다.

    [최근 실패 샘플]
    #{failure_summary}

    현재 스킬은 `@behaviour TeamJay.Ska.Skill` 을 구현합니다 (run/2, metadata/0).
    실패 원인을 분석하고, 개선 방향을 한국어로 제안해주세요.
    코드 변경이 필요한 경우 핵심 변경 부분만 명시해주세요.
    """
  end

  defp notify_improvement_proposal(skill_name, failure_count, suggestion) do
    message = """
    🔧 [SelfRewarding] 스킬 개선 제안: #{skill_name}

    최근 7일 실패 #{failure_count}건 (임계값 #{@rejection_trigger_count}건 초과).

    LLM 제안:
    #{String.slice(suggestion, 0, 500)}

    ⚠️ 마스터 검토 후 수동 적용 필요 (자동 적용 없음).
    """

    try do
      Jay.Core.HubClient.post_alarm(message, "ska", "self_rewarding")
    rescue
      e -> Logger.warning("[SelfRewarding] 알람 발송 실패: #{inspect(e)}")
    end
  end

  defp call_llm(prompt) do
    try do
      case Jay.Core.LLM.HubClient.Impl.call(
             %{
               prompt: prompt,
               abstract_model: :local_fast,
               timeout_ms: 30_000,
               agent: :ska_self_rewarding,
               urgency: :low,
               task_type: :analysis
             },
             "ska"
           ) do
        {:ok, %{result: content}} ->
          normalize_llm_result(content)

        {:error, reason} ->
          Logger.warning("[SelfRewarding] Hub LLM 호출 실패: #{inspect(reason)}")
          {:error, reason}
      end
    rescue
      e ->
        Logger.warning("[SelfRewarding] LLM 호출 예외: #{inspect(e)}")
        {:error, :llm_call_failed}
    end
  end

  defp normalize_llm_result(content) when is_binary(content) do
    case Jason.decode(content) do
      {:ok, parsed} ->
        {:ok, parsed}

      {:error, _} ->
        {:ok,
         %{
           "score" => 0.5,
           "category" => "neutral",
           "failure_cause" => "n/a",
           "critique" => content,
           "improvement_hint" => ""
         }}
    end
  end

  defp normalize_llm_result(content) when is_map(content), do: {:ok, content}
  defp normalize_llm_result(content), do: {:ok, %{"score" => 0.5, "category" => "neutral", "critique" => inspect(content)}}

  defp enabled? do
    System.get_env("SKA_SELF_REWARDING_ENABLED", "false") == "true"
  end
end
