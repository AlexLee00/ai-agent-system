defmodule TeamJay.Ska.Skill.NotifyFailure do
  @moduledoc """
  실패 알림 스킬 — 모든 에이전트 공통.
  Severity별 채널 결정 (telegram urgent/info/daily).

  입력: %{agent: :andy, severity: :error, message: "...", metadata: %{}}
  출력: {:ok, %{notified: true, channels: [...]}}
  """

  @behaviour TeamJay.Ska.Skill

  @impl true
  def metadata do
    %{
      name: :notify_failure,
      domain: :common,
      version: "1.0",
      description: "에이전트 실패를 적절한 채널로 알림",
      input_schema: %{agent: :atom, severity: :atom, message: :string, metadata: :map},
      output_schema: %{notified: :boolean, channels: :list}
    }
  end

  @impl true
  def run(params, _context) do
    severity = params[:severity] || :warning
    agent = params[:agent]
    message = "[#{agent}] #{params[:message]}"

    channels =
      case severity do
        :critical -> [:telegram_urgent, :telegram_general, :event_lake]
        :error -> [:telegram_urgent, :event_lake]
        :warning -> [:telegram_general, :event_lake]
        :info -> [:event_lake]
        _ -> []
      end

    Enum.each(channels, fn channel -> dispatch(channel, message, params) end)
    {:ok, %{notified: true, channels: channels}}
  end

  defp dispatch(:telegram_urgent, msg, _params) do
    Jay.Core.HubClient.post_alarm(msg, "ska", "notify_failure")
  end

  defp dispatch(:telegram_general, msg, _params) do
    Jay.Core.HubClient.post_alarm(msg, "ska", "notify_failure")
  end

  defp dispatch(:event_lake, _msg, params) do
    if Process.whereis(Jay.Core.EventLake) do
      Jay.Core.EventLake.record(
        params
        |> Map.put(:event_type, "agent_failure")
        |> Map.put_new(:team, "ska")
        |> Map.put_new(:bot_name, "notify_failure")
        |> Map.put_new(:severity, "warn")
        |> Map.put_new(:message, params[:message] || params["message"] || "agent failure")
        |> Map.put_new(:metadata, %{})
      )
    end
  end
end
