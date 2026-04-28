defmodule Luna.V2.Feedback.SelfRewarding do
  @moduledoc """
  Self-Rewarding Loop (2026 트렌드).

  LLM-as-a-Judge 기반 거래 자체 평가:
  1. 거래 완료 → PnL + holding time + max_dd 측정
  2. LLM 심사: rationale과 실제 결과 일치도
  3. score(0.0~1.0) + critique 생성
  4. High score → preferred / Low score → rejected
  5. DPO 데이터셋 축적
  6. Agentic RAG 인덱스 업데이트
  """
  require Logger

  alias Luna.V2.Rag.AgenticRag

  @preferred_threshold 0.7
  @rejected_threshold  0.4

  def evaluate_trade(trade_id) when is_integer(trade_id) do
    with {:ok, trade}    <- fetch_trade(trade_id),
         {:ok, rationale} <- fetch_rationale(trade_id),
         {:ok, outcome}  <- calc_outcome(trade),
         {:ok, judgment} <- llm_judge(trade, rationale, outcome) do

      category = classify(judgment[:score])

      store_dpo_pair(%{
        trade_id: trade_id,
        rationale: rationale,
        outcome_summary: outcome,
        score: judgment[:score],
        critique: judgment[:critique],
        category: category
      })

      AgenticRag.index_trade_review(trade, judgment)

      # Phase A/B/C 품질 평가 요청 (TypeScript orchestrator가 처리)
      trigger_quality_evaluation(trade_id, category)

      {:ok, judgment}
    end
  end
  def evaluate_trade(_), do: {:error, :invalid_trade_id}

  def get_dpo_stats do
    query = """
    SELECT category, COUNT(*), AVG(score)
    FROM luna_dpo_preference_pairs
    GROUP BY category
    """
    Jay.Core.Repo.query(query, [])
  end

  # ─── Internal ───────────────────────────────────────────────────

  defp fetch_trade(trade_id) do
    query = """
    SELECT id, symbol, market, direction, entry_price, exit_price, amount_krw,
           entry_at, exit_at, exit_reason
    FROM investment.trade_history
    WHERE id = $1
    """
    case Jay.Core.Repo.query(query, [trade_id]) do
      {:ok, %{columns: cols, rows: [row | _]}} ->
        {:ok, cols |> Enum.zip(row) |> Enum.into(%{})}
      {:ok, %{rows: []}} -> {:error, :trade_not_found}
      err -> err
    end
  end

  defp fetch_rationale(trade_id) do
    query = """
    SELECT content FROM luna_rag_documents
    WHERE category = 'thesis'
      AND metadata->>'trade_id' = $1::text
    ORDER BY created_at DESC LIMIT 1
    """
    case Jay.Core.Repo.query(query, [to_string(trade_id)]) do
      {:ok, %{rows: [[content | _] | _]}} -> {:ok, content}
      _ -> {:ok, "rationale 없음"}
    end
  end

  defp calc_outcome(trade) do
    entry = to_f(trade["entry_price"])
    exit  = to_f(trade["exit_price"])
    dir   = trade["direction"]

    pnl_pct = if entry > 0 do
      raw = (exit - entry) / entry * 100
      if dir == "short", do: -raw, else: raw
    else
      0.0
    end

    {:ok, %{
      pnl_pct: Float.round(pnl_pct, 4),
      exit_reason: trade["exit_reason"],
      symbol: trade["symbol"]
    }}
  end

  defp llm_judge(trade, rationale, outcome) do
    prompt = """
    당신은 엄격한 퀀트 트레이딩 심사관입니다.

    거래 정보:
    - 심볼: #{trade["symbol"]}, 방향: #{trade["direction"]}
    - PnL: #{outcome[:pnl_pct]}%, 청산 이유: #{outcome[:exit_reason]}

    당시 매매 근거:
    #{rationale}

    평가 기준:
    1. rationale이 실제 결과와 얼마나 일치했는가? (0.0~1.0)
    2. 운이 작용했는가, 분석이 정확했는가?
    3. 개선점은 무엇인가?

    반드시 JSON 형식으로만 답하세요:
    {"score": 0.75, "critique": "...", "improvements": ["...", "..."]}
    """

    case Luna.V2.LLM.Selector.call_with_fallback("luna.self_rewarding_judge", prompt,
           urgency: :low,
           task_type: :trade_evaluation,
           max_tokens: 512
         ) do
      {:ok, text} -> parse_judgment(text)
      _           -> {:ok, %{score: 0.5, critique: "LLM 평가 불가", improvements: []}}
    end
  end

  defp parse_judgment(text) do
    case Jason.decode(text) do
      {:ok, %{"score" => s, "critique" => c} = raw} ->
        {:ok, %{
          score: min(1.0, max(0.0, s)),
          critique: c,
          improvements: Map.get(raw, "improvements", [])
        }}
      _ ->
        # JSON 블록 추출 시도
        case Regex.run(~r/\{.*\}/s, text) do
          [json_str] ->
            case Jason.decode(json_str) do
              {:ok, parsed} -> {:ok, %{score: parsed["score"] || 0.5, critique: parsed["critique"] || "", improvements: []}}
              _ -> {:ok, %{score: 0.5, critique: text, improvements: []}}
            end
          _ ->
            {:ok, %{score: 0.5, critique: text, improvements: []}}
        end
    end
  end

  defp classify(score) when score >= @preferred_threshold, do: "preferred"
  defp classify(score) when score <= @rejected_threshold,  do: "rejected"
  defp classify(_),                                        do: "neutral"

  defp store_dpo_pair(pair) do
    query = """
    INSERT INTO luna_dpo_preference_pairs
      (trade_id, rationale, outcome_summary, score, critique, category)
    VALUES ($1, $2, $3, $4, $5, $6)
    """
    Jay.Core.Repo.query(query, [
      pair[:trade_id],
      pair[:rationale],
      Jason.encode!(pair[:outcome_summary]),
      pair[:score],
      pair[:critique],
      pair[:category]
    ])
  rescue
    e -> Logger.error("[SelfRewarding] DPO 저장 실패: #{inspect(e)}")
  end

  # TypeScript posttrade feedback orchestrator (runtime-posttrade-feedback.ts)가
  # mapek_knowledge 'quality_evaluation_pending' 이벤트를 polling하여 A/B/C 실행.
  defp trigger_quality_evaluation(trade_id, dpo_category) do
    Task.start(fn ->
      query = """
      INSERT INTO investment.mapek_knowledge (event_type, payload)
      VALUES ('quality_evaluation_pending', $1)
      """
      payload = Jason.encode!(%{trade_id: trade_id, dpo_category: dpo_category})
      case Jay.Core.Repo.query(query, [payload]) do
        {:ok, _} -> :ok
        {:error, e} -> Logger.error("[SelfRewarding] quality_pending 저장 실패: #{inspect(e)}")
      end
    end)
  end

  defp to_f(nil), do: 0.0
  defp to_f(d) when is_struct(d, Decimal), do: Decimal.to_float(d)
  defp to_f(n) when is_number(n), do: n * 1.0
  defp to_f(_), do: 0.0
end
