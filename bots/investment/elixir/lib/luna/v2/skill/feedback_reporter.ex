defmodule Luna.V2.Skill.FeedbackReporter do
  @moduledoc "MAPE-K Knowledge 저장 + 텔레그램 브리핑 발송"
  use Jido.Action,
    name: "feedback_reporter",
    description: "MAPE-K 지식 저장 및 텔레그램 운영 브리핑을 발송합니다.",
    schema: [
      event_type: [type: :string, required: true,
                   doc: "이벤트 종류 (daily_briefing/mapek_cycle/risk_alert/signal_outcome)"],
      payload:    [type: :map, required: true, doc: "저장할 지식 페이로드"]
    ]

  require Logger

  def run(%{event_type: event_type, payload: payload}, _context) do
    Logger.info("[루나V2/FeedbackReporter] 이벤트 저장 type=#{event_type}")
    with {:ok, _} <- save_knowledge(event_type, payload),
         :ok      <- maybe_notify(event_type, payload) do
      {:ok, %{saved: true, event_type: event_type, saved_at: DateTime.utc_now()}}
    else
      {:error, reason} ->
        Logger.warning("[루나V2/FeedbackReporter] 저장 실패: #{inspect(reason)}")
        {:ok, %{saved: false, error: inspect(reason)}}
    end
  end

  defp save_knowledge(event_type, payload) do
    query = """
    INSERT INTO investment.mapek_knowledge
      (event_type, payload, created_at)
    VALUES ($1, $2, NOW())
    RETURNING id
    """
    case Jay.Core.Repo.query(query, [event_type, Jason.encode!(payload)]) do
      {:ok, _}         -> {:ok, :saved}
      {:error, reason} -> {:error, reason}
    end
  end

  defp maybe_notify("risk_alert", payload) do
    msg = "[루나V2 🚨 리스크 알림]\n#{format_payload(payload)}"
    send_telegram(msg)
  end
  defp maybe_notify("daily_briefing", payload) do
    msg = "[루나V2 📊 일일 브리핑]\n#{format_payload(payload)}"
    send_telegram(msg)
  end
  defp maybe_notify(_, _), do: :ok

  defp format_payload(payload) when is_map(payload) do
    payload
    |> Enum.map(fn {k, v} -> "• #{k}: #{inspect(v)}" end)
    |> Enum.join("\n")
  end
  defp format_payload(payload), do: inspect(payload)

  defp send_telegram(message) do
    try do
      Jay.Core.HubClient.post_alarm(message, "investment", "luna_v2")
      :ok
    rescue
      _ -> :ok
    end
  end
end
