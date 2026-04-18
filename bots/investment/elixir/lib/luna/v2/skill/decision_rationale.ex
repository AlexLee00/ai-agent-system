defmodule Luna.V2.Skill.DecisionRationale do
  @moduledoc """
  승인된 후보에 대해 설명 가능한 rationale 생성 + 최종 주문 확정.

  Hub LLM 호출로 rationale 텍스트 생성 후 luna_rag_documents에 thesis 저장.
  """
  use Jido.Action,
    name:        "decision_rationale",
    description: "최종 주문 결정 및 rationale 생성",
    schema: [
      approved: [type: {:list, :map}, required: true],
      market:   [type: :atom, required: true]
    ]

  require Logger

  @impl true
  def run(%{approved: approved, market: market}, _context) do
    orders =
      approved
      |> Enum.map(&finalize_order(&1, market))
      |> Enum.filter(&(not is_nil(&1)))

    Logger.info("[DecisionRationale] 주문 확정 #{length(orders)}건")
    {:ok, %{orders: orders, market: market}}
  end

  defp finalize_order(candidate, market) do
    rationale = generate_rationale(candidate, market)

    order = %{
      symbol:       candidate[:symbol],
      market:       market,
      direction:    candidate[:direction] || :long,
      amount_krw:   candidate[:amount_krw] || 100_000,
      budget_lane:  candidate[:budget_lane] || :normal,
      regime:       candidate[:regime],
      score:        candidate[:score],
      rationale:    rationale,
      thesis_id:    store_thesis(candidate, rationale),
      created_at:   DateTime.utc_now()
    }

    order
  rescue
    e ->
      Logger.error("[DecisionRationale] 주문 생성 실패: #{inspect(e)}")
      nil
  end

  defp generate_rationale(candidate, market) do
    prompt = """
    다음 매매 결정에 대해 간결한 투자 근거를 한국어 2~3문장으로 작성하세요.
    심볼: #{candidate[:symbol]}, 시장: #{market}, 방향: #{candidate[:direction]},
    신호 점수: #{candidate[:score]}, 시장 레짐: #{candidate[:regime]}
    """

    case Luna.V2.LLM.Selector.call_with_fallback("luna.decision_rationale", prompt,
           urgency: :low,
           task_type: :rationale_generation,
           max_tokens: 256
         ) do
      {:ok, text} ->
        text
      _ ->
        "#{candidate[:symbol]} #{candidate[:direction]} 포지션 진입 — 신호 점수 #{Float.round(candidate[:score] || 0.0, 2)}, regime: #{candidate[:regime]}"
    end
  end

  defp store_thesis(candidate, rationale) do
    query = """
    INSERT INTO luna_rag_documents (category, symbol, market, content, metadata)
    VALUES ('thesis', $1, $2, $3, $4)
    RETURNING id
    """
    metadata = Jason.encode!(%{
      direction: candidate[:direction],
      score: candidate[:score],
      regime: candidate[:regime],
      stored_at: DateTime.utc_now() |> DateTime.to_iso8601()
    })

    case Jay.Core.Repo.query(query, [
      candidate[:symbol], to_string(candidate[:market] || :unknown),
      rationale, metadata
    ]) do
      {:ok, %{rows: [[id | _] | _]}} -> id
      _ -> nil
    end
  rescue
    _ -> nil
  end
end
