defmodule Luna.V2.Skill.ReviewFeedback do
  @moduledoc """
  거래 완료 후 비동기 Chronos 회고 트리거.

  - MAPE-K Knowledge 저장
  - Agentic RAG 인덱싱 요청
  - Self-Rewarding 평가 요청
  """
  use Jido.Action,
    name:        "review_feedback",
    description: "거래 완료 후 피드백 루프 트리거",
    schema: [
      executed: [type: {:list, :map}, required: true]
    ]

  require Logger

  @impl true
  def run(%{executed: executed}, _context) do
    Enum.each(executed, fn order ->
      Task.start(fn ->
        order_id = order[:execution]["order_id"] || order[:thesis_id]
        trigger_chronos_review(order_id, order)
        trigger_rag_indexing(order)
      end)
    end)

    {:ok, %{triggered: length(executed)}}
  end

  defp trigger_chronos_review(order_id, order) do
    store_mapek_knowledge(:trade_dispatched, %{
      order_id: order_id,
      symbol: order[:symbol],
      market: order[:market],
      direction: order[:direction],
      amount_krw: order[:amount_krw],
      rationale: order[:rationale]
    })
  end

  defp trigger_rag_indexing(order) do
    content = "#{order[:symbol]} #{order[:direction]} 진입 — #{order[:rationale]}"

    query = """
    INSERT INTO luna_rag_documents (category, symbol, market, content, metadata)
    VALUES ('trade_review', $1, $2, $3, $4)
    ON CONFLICT DO NOTHING
    """
    metadata = Jason.encode!(%{
      direction: order[:direction],
      amount_krw: order[:amount_krw],
      dispatched_at: DateTime.utc_now() |> DateTime.to_iso8601()
    })

    Jay.Core.Repo.query(query, [
      order[:symbol], to_string(order[:market] || :unknown),
      content, metadata
    ])
  rescue
    e -> Logger.error("[ReviewFeedback] RAG 인덱싱 실패: #{inspect(e)}")
  end

  defp store_mapek_knowledge(event_type, data) do
    query = """
    INSERT INTO mapek_knowledge (event_type, payload, recorded_at)
    VALUES ($1, $2, NOW())
    """
    Jay.Core.Repo.query(query, [to_string(event_type), Jason.encode!(data)])
  rescue
    e -> Logger.error("[ReviewFeedback] Knowledge 저장 실패: #{inspect(e)}")
  end
end
