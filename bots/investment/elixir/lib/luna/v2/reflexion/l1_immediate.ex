defmodule Luna.V2.Reflexion.L1Immediate do
  @moduledoc """
  Reflexion Layer 1 — 즉시 평가 (실시간, 거래 직후)
  Shinn et al. (2023) Reflexion 패턴 + Self-Rewarding (Du et al. 2023) 통합.

  기존 Luna.V2.Feedback.SelfRewarding을 감싸서 3-Layer 체계에 통합한다.
  L1은 단일 거래를 즉시 평가하고 DPO 쌍(preferred/rejected)을 축적한다.

  흐름:
    거래 완료 → evaluate/1 → SelfRewarding.evaluate_trade/1
              → DPO 저장 → RAG 인덱싱 → L2 큐 삽입
  """
  require Logger
  alias Luna.V2.Feedback.SelfRewarding

  def evaluate(trade_id) when is_integer(trade_id) do
    case SelfRewarding.evaluate_trade(trade_id) do
      {:ok, judgment} ->
        maybe_enqueue_l2(trade_id, judgment)
        {:ok, judgment}

      err ->
        Logger.warning("[Reflexion.L1] trade_id=#{trade_id} 평가 실패: #{inspect(err)}")
        err
    end
  end

  defp maybe_enqueue_l2(trade_id, %{score: score}) do
    query = """
    INSERT INTO investment.mapek_knowledge (event_type, payload)
    VALUES ('reflexion_l2_pending', $1)
    ON CONFLICT DO NOTHING
    """
    payload = Jason.encode!(%{trade_id: trade_id, l1_score: score, enqueued_at: DateTime.utc_now()})
    case Jay.Core.Repo.query(query, [payload]) do
      {:ok, _} -> :ok
      {:error, e} -> Logger.warning("[Reflexion.L1] L2 큐 삽입 실패: #{inspect(e)}")
    end
  end
end
