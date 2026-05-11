defmodule Luna.V2.Reflexion.L2Daily do
  @moduledoc """
  Reflexion Layer 2 — 일 배치 분석 (하루 거래 패턴 평가)
  AutoGen (Wu 2023) GroupChat + Reflexion 패턴 기반.

  수행 내용:
    1. 오늘 DPO 쌍 집계 (preferred/neutral/rejected)
    2. 패턴 분석 — 어떤 조건에서 preferred가 많았는가?
    3. LLM 정책 개선 제안 생성
    4. 개선 제안 → mapek_knowledge 저장 + L3 큐 삽입

  실행:
    mix luna.reflexion --layer=2 --batch
    또는 Scheduler가 KST 22:30에 자동 실행
  """
  require Logger

  @min_samples 3

  def run(date \\ nil) do
    date_str = date || kst_today()
    Logger.info("[Reflexion.L2] #{date_str} 일 배치 시작")

    with {:ok, dpo_rows} <- fetch_dpo_for_date(date_str),
         true <- length(dpo_rows) >= @min_samples || {:skip, :insufficient_data},
         {:ok, analysis} <- analyze_patterns(dpo_rows, date_str),
         {:ok, suggestions} <- llm_policy_suggestions(analysis, date_str) do

      store_l2_result(date_str, analysis, suggestions)
      enqueue_l3(date_str, suggestions)
      {:ok, %{date: date_str, trade_count: length(dpo_rows), suggestions: suggestions}}
    else
      {:skip, :insufficient_data} ->
        Logger.info("[Reflexion.L2] #{date_str} 샘플 부족 (< #{@min_samples}), 스킵")
        {:ok, :skipped}
      err ->
        Logger.warning("[Reflexion.L2] #{date_str} 실패: #{inspect(err)}")
        err
    end
  end

  # ─── Internal ────────────────────────────────────────────────────

  defp fetch_dpo_for_date(date_str) do
    query = """
    SELECT trade_id, rationale, outcome_summary, score, critique, category
    FROM luna_dpo_preference_pairs
    WHERE DATE(created_at AT TIME ZONE 'Asia/Seoul') = $1::date
    ORDER BY created_at
    """
    case Jay.Core.Repo.query(query, [date_str]) do
      {:ok, %{columns: cols, rows: rows}} ->
        {:ok, Enum.map(rows, &Enum.zip(cols, &1) |> Enum.into(%{}))}
      err -> err
    end
  end

  defp analyze_patterns(rows, date_str) do
    preferred = Enum.filter(rows, &(&1["category"] == "preferred"))
    rejected  = Enum.filter(rows, &(&1["category"] == "rejected"))
    neutral   = Enum.filter(rows, &(&1["category"] == "neutral"))

    avg_score = rows |> Enum.map(&to_float(&1["score"])) |> avg()

    analysis = %{
      date: date_str,
      total: length(rows),
      preferred_count: length(preferred),
      rejected_count:  length(rejected),
      neutral_count:   length(neutral),
      avg_score: Float.round(avg_score, 4),
      preferred_critiques: Enum.map(preferred, &(&1["critique"])) |> Enum.take(3),
      rejected_critiques:  Enum.map(rejected,  &(&1["critique"])) |> Enum.take(3),
    }
    {:ok, analysis}
  end

  defp llm_policy_suggestions(analysis, date_str) do
    prompt = """
    당신은 퀀트 트레이딩 전략 코치입니다.

    #{date_str} 일일 거래 성과 분석:
    - 총 거래: #{analysis.total}건
    - 성공(preferred): #{analysis.preferred_count}건, 실패(rejected): #{analysis.rejected_count}건
    - 평균 점수: #{analysis.avg_score}

    성공 근거 샘플:
    #{Enum.map_join(analysis.preferred_critiques, "\n", &"- #{&1}")}

    실패 근거 샘플:
    #{Enum.map_join(analysis.rejected_critiques, "\n", &"- #{&1}")}

    다음 날을 위한 정책 개선 제안 3가지를 제시하세요.
    반드시 JSON 형식으로만 답하세요:
    {"suggestions":["제안1","제안2","제안3"],"key_pattern":"핵심 패턴 1문장","confidence":0~1}
    """

    case Luna.V2.LLM.Selector.call_with_fallback("luna.reflexion_l2", prompt,
           urgency: :low,
           task_type: :policy_review,
           max_tokens: 500
         ) do
      {:ok, text} -> parse_suggestions(text)
      _           -> {:ok, %{suggestions: [], key_pattern: "LLM 불가", confidence: 0.0}}
    end
  end

  defp parse_suggestions(text) do
    case Jason.decode(text) do
      {:ok, %{"suggestions" => s} = raw} ->
        {:ok, %{
          suggestions:  s,
          key_pattern:  Map.get(raw, "key_pattern", ""),
          confidence:   Map.get(raw, "confidence", 0.5),
        }}
      _ ->
        case Regex.run(~r/\{.*\}/s, text) do
          [json_str] ->
            case Jason.decode(json_str) do
              {:ok, parsed} ->
                {:ok, %{
                  suggestions: parsed["suggestions"] || [],
                  key_pattern: parsed["key_pattern"] || "",
                  confidence:  parsed["confidence"] || 0.5,
                }}
              _ -> {:ok, %{suggestions: [], key_pattern: text, confidence: 0.0}}
            end
          _ -> {:ok, %{suggestions: [], key_pattern: text, confidence: 0.0}}
        end
    end
  end

  defp store_l2_result(date_str, analysis, suggestions) do
    query = """
    INSERT INTO investment.mapek_knowledge (event_type, payload)
    VALUES ('reflexion_l2_result', $1)
    """
    payload = Jason.encode!(%{
      date: date_str,
      analysis: analysis,
      suggestions: suggestions,
      created_at: DateTime.utc_now()
    })
    case Jay.Core.Repo.query(query, [payload]) do
      {:ok, _} -> :ok
      {:error, e} -> Logger.warning("[Reflexion.L2] 결과 저장 실패: #{inspect(e)}")
    end
  end

  defp enqueue_l3(date_str, suggestions) do
    query = """
    INSERT INTO investment.mapek_knowledge (event_type, payload)
    VALUES ('reflexion_l3_pending', $1)
    ON CONFLICT DO NOTHING
    """
    payload = Jason.encode!(%{
      date: date_str,
      l2_suggestions: suggestions,
      enqueued_at: DateTime.utc_now()
    })
    case Jay.Core.Repo.query(query, [payload]) do
      {:ok, _} -> :ok
      {:error, e} -> Logger.warning("[Reflexion.L2] L3 큐 삽입 실패: #{inspect(e)}")
    end
  end

  defp kst_today do
    now = DateTime.utc_now()
    kst = DateTime.add(now, 9 * 3600, :second)
    Date.to_string(DateTime.to_date(kst))
  end

  defp avg([]), do: 0.0
  defp avg(list), do: Enum.sum(list) / length(list)

  defp to_float(nil), do: 0.0
  defp to_float(d) when is_struct(d, Decimal), do: Decimal.to_float(d)
  defp to_float(n) when is_number(n), do: n * 1.0
  defp to_float(_), do: 0.0
end
