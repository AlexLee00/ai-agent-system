defmodule Luna.V2.Reflexion.L3Weekly do
  @moduledoc """
  Reflexion Layer 3 — 주 배치 메타 평가 (전략 진화 권고)
  MetaGPT (Hong 2023) SOP + Reflexion 메타 학습 패턴 기반.

  수행 내용:
    1. 최근 7일 L2 결과 집계
    2. 주간 추세 분석 (점수 추이, 패턴 변화)
    3. 전략 진화 권고 LLM 생성
    4. 권고안 → A2A broadcast (다윈/시그마 팀 공유)
    5. strategy_registry 업데이트 제안 (마스터 검토용)

  실행:
    mix luna.reflexion --layer=3 --batch
    또는 Scheduler가 매주 일요일 KST 23:00에 자동 실행
  """
  require Logger

  @lookback_days 7

  def run(end_date \\ nil) do
    end_d = end_date || kst_today()
    start_d = shift_days(end_d, -@lookback_days)
    Logger.info("[Reflexion.L3] #{start_d} ~ #{end_d} 주간 배치 시작")

    with {:ok, l2_results} <- fetch_l2_results(start_d, end_d),
         {:ok, summary} <- summarize_week(l2_results, start_d, end_d),
         {:ok, evolution} <- llm_strategy_evolution(summary) do

      store_l3_result(end_d, summary, evolution)
      broadcast_to_darwin(evolution)
      {:ok, %{period: "#{start_d}~#{end_d}", trade_days: length(l2_results), evolution: evolution}}
    else
      err ->
        Logger.warning("[Reflexion.L3] 주간 배치 실패: #{inspect(err)}")
        err
    end
  end

  # ─── Internal ────────────────────────────────────────────────────

  defp fetch_l2_results(start_d, end_d) do
    query = """
    SELECT payload
    FROM investment.mapek_knowledge
    WHERE event_type = 'reflexion_l2_result'
      AND created_at >= $1::date
      AND created_at <  $2::date + interval '1 day'
    ORDER BY created_at
    """
    case Jay.Core.Repo.query(query, [start_d, end_d]) do
      {:ok, %{rows: rows}} ->
        results = Enum.flat_map(rows, fn [payload] ->
          case Jason.decode(payload) do
            {:ok, d} -> [d]
            _        -> []
          end
        end)
        {:ok, results}
      err -> err
    end
  end

  defp summarize_week(l2_results, start_d, end_d) do
    scores = Enum.map(l2_results, fn r ->
      get_in(r, ["analysis", "avg_score"]) || 0.0
    end)

    all_suggestions = Enum.flat_map(l2_results, fn r ->
      get_in(r, ["suggestions", "suggestions"]) || []
    end)

    avg_score = case scores do
      [] -> 0.0
      s  -> Enum.sum(s) / length(s)
    end

    trend = cond do
      length(scores) < 2  -> "데이터 부족"
      List.last(scores) > hd(scores) -> "개선 추세"
      List.last(scores) < hd(scores) -> "악화 추세"
      true                            -> "횡보"
    end

    {:ok, %{
      period: "#{start_d}~#{end_d}",
      trade_days: length(l2_results),
      avg_weekly_score: Float.round(avg_score, 4),
      score_trend: trend,
      daily_scores: scores,
      top_suggestions: all_suggestions |> Enum.frequencies() |> Enum.sort_by(&elem(&1, 1), :desc) |> Enum.take(5) |> Enum.map(&elem(&1, 0)),
    }}
  end

  defp llm_strategy_evolution(summary) do
    prompt = """
    당신은 퀀트 트레이딩 전략 진화 전문가입니다.

    주간 성과 요약 (#{summary.period}):
    - 거래일: #{summary.trade_days}일
    - 평균 점수: #{summary.avg_weekly_score}
    - 추세: #{summary.score_trend}
    - 일별 점수: #{Enum.join(Enum.map(summary.daily_scores, &Float.round(&1, 3)), ", ")}

    주간 반복 개선 제안 TOP 5:
    #{Enum.map_join(summary.top_suggestions, "\n", &"- #{&1}")}

    이번 주 분석을 바탕으로:
    1. 전략 진화 방향 (구체적인 파라미터 변경 권고)
    2. 폐기 권고 패턴 (반복 실패 패턴)
    3. 다윈팀 R&D 의뢰 항목 (자동화 가능한 개선)

    반드시 JSON 형식으로만 답하세요:
    {
      "evolution_direction": "전략 진화 방향 2문장",
      "deprecate_patterns": ["패턴1", "패턴2"],
      "darwin_rnd_requests": ["R&D1", "R&D2"],
      "confidence": 0~1,
      "priority": "HIGH|MEDIUM|LOW"
    }
    """

    case Luna.V2.LLM.Selector.call_with_fallback("luna.reflexion_l3", prompt,
           urgency: :low,
           task_type: :strategy_evolution,
           max_tokens: 700
         ) do
      {:ok, text} -> parse_evolution(text)
      _           ->
        {:ok, %{
          evolution_direction: "LLM 불가",
          deprecate_patterns: [],
          darwin_rnd_requests: [],
          confidence: 0.0,
          priority: "LOW"
        }}
    end
  end

  defp parse_evolution(text) do
    case Jason.decode(text) do
      {:ok, %{"evolution_direction" => dir} = raw} ->
        {:ok, %{
          evolution_direction: dir,
          deprecate_patterns:  Map.get(raw, "deprecate_patterns", []),
          darwin_rnd_requests: Map.get(raw, "darwin_rnd_requests", []),
          confidence:          Map.get(raw, "confidence", 0.5),
          priority:            Map.get(raw, "priority", "MEDIUM"),
        }}
      _ ->
        case Regex.run(~r/\{.*\}/s, text) do
          [json_str] ->
            case Jason.decode(json_str) do
              {:ok, parsed} ->
                {:ok, %{
                  evolution_direction: parsed["evolution_direction"] || "",
                  deprecate_patterns:  parsed["deprecate_patterns"] || [],
                  darwin_rnd_requests: parsed["darwin_rnd_requests"] || [],
                  confidence:          parsed["confidence"] || 0.5,
                  priority:            parsed["priority"] || "MEDIUM",
                }}
              _ -> {:error, :parse_failed}
            end
          _ -> {:error, :parse_failed}
        end
    end
  end

  defp store_l3_result(end_d, summary, evolution) do
    query = """
    INSERT INTO investment.mapek_knowledge (event_type, payload)
    VALUES ('reflexion_l3_result', $1)
    """
    payload = Jason.encode!(%{
      end_date: end_d,
      summary: summary,
      evolution: evolution,
      created_at: DateTime.utc_now()
    })
    case Jay.Core.Repo.query(query, [payload]) do
      {:ok, _} -> :ok
      {:error, e} -> Logger.warning("[Reflexion.L3] 결과 저장 실패: #{inspect(e)}")
    end
  end

  # 다윈팀 R&D 의뢰를 A2A broadcast로 전달 (비동기, 실패 무시)
  defp broadcast_to_darwin(evolution) do
    requests = evolution[:darwin_rnd_requests] || []
    if requests != [] do
      Task.start(fn ->
        url = System.get_env("DARWIN_A2A_URL", "http://localhost:8766")
        payload = Jason.encode!(%{
          type: "luna.reflexion.l3.rnd_request",
          payload: %{requests: requests, priority: evolution[:priority]},
          source: "luna",
          timestamp: DateTime.utc_now()
        })
        case :hackney.post("#{url}/a2a/notify", [{"Content-Type", "application/json"}], payload, []) do
          {:ok, 200, _, _} -> :ok
          err -> Logger.debug("[Reflexion.L3] 다윈 broadcast 실패 (무시): #{inspect(err)}")
        end
      end)
    end
  end

  defp kst_today do
    now = DateTime.utc_now()
    kst = DateTime.add(now, 9 * 3600, :second)
    Date.to_string(DateTime.to_date(kst))
  end

  defp shift_days(date_str, days) do
    {:ok, date} = Date.from_iso8601(date_str)
    Date.to_string(Date.add(date, days))
  end
end
