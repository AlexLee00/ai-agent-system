defmodule TeamJay.Ska.Skill.ClassifyKioskState do
  @moduledoc """
  피코 키오스크 상태 분류 스킬 — Jimmy 전용.

  정상/주문중/결제대기/멈춤/오프라인 등을 응답 데이터에서 판단.

  입력: %{response: %{status: "idle", ...}, last_heartbeat_ms: 3000}
  출력: {:ok, %{state: :idle, confidence: 0.95, reason: "no_active_session"}}
  """

  @behaviour TeamJay.Ska.Skill

  @heartbeat_timeout_ms 60_000

  @impl true
  def metadata do
    %{
      name: :classify_kiosk_state,
      domain: :kiosk,
      version: "1.0",
      description: "키오스크 응답에서 현재 상태 분류",
      input_schema: %{response: :map, last_heartbeat_ms: :integer},
      output_schema: %{state: :atom, confidence: :float, reason: :string}
    }
  end

  @impl true
  def run(params, _context) do
    response = params[:response] || %{}
    heartbeat_ms = params[:last_heartbeat_ms] || 0

    state =
      cond do
        heartbeat_ms > @heartbeat_timeout_ms -> :offline
        response[:error_code] == "SYSTEM_FROZEN" -> :frozen
        response[:status] == "processing_order" -> :active
        response[:status] == "payment_pending" -> :payment_wait
        response[:status] == "idle" -> :idle
        true -> :unknown
      end

    confidence = if state == :unknown, do: 0.3, else: 0.95

    {:ok, %{
      state: state,
      confidence: confidence,
      reason: classify_reason(state)
    }}
  end

  defp classify_reason(:offline), do: "heartbeat_timeout_60s"
  defp classify_reason(:frozen), do: "explicit_frozen_error_code"
  defp classify_reason(:active), do: "order_in_progress"
  defp classify_reason(:payment_wait), do: "awaiting_payment"
  defp classify_reason(:idle), do: "no_active_session"
  defp classify_reason(_), do: "insufficient_signals"
end
