defmodule TeamJay.Blog.Notifier do
  @moduledoc """
  블로그팀 Phase 1 운영 알림 도우미.

  일간 요약을 허브 알람 메시지 형태로 바꾸고, 필요할 때 전송한다.
  기본 사용은 dry-run 확인을 먼저 권장한다.
  """

  alias TeamJay.Blog.DailySummary
  alias TeamJay.Blog.SummaryFormatter
  alias TeamJay.HubClient

  def build_message(style \\ :ops) do
    DailySummary.build()
    |> SummaryFormatter.format(style)
    |> prepend_header()
  end

  def notify(opts \\ []) do
    style = Keyword.get(opts, :style, :ops)
    send? = Keyword.get(opts, :send, false)

    message = build_message(style)

    if send? do
      response = HubClient.post_alarm(message, "blog", "blog-phase1")
      %{sent: true, message: message, response: summarize_response(response)}
    else
      %{sent: false, message: message}
    end
  end

  defp prepend_header(message) do
    "🧱 블로그 Phase 1 운영 리포트\n" <> message
  end

  defp summarize_response({:ok, %{status: status, body: body}}) do
    %{ok: status in 200..299, status: status, body: body}
  end

  defp summarize_response({:error, reason}) do
    %{ok: false, error: inspect(reason)}
  end

  defp summarize_response(other) do
    %{ok: false, error: inspect(other)}
  end
end
