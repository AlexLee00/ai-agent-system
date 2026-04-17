defmodule TeamJay.Investment.Feedback.Daily do
  @moduledoc """
  투자팀 일일 피드백 호출 스캐폴드.

  현재 운영 중인 Node.js daily_feedback PortAgent를 감싸는 얇은 인터페이스다.
  향후 일일 피드백 로직을 Elixir 네이티브로 옮길 때 교체 지점으로 사용한다.
  """

  alias Jay.Core.Agents.PortAgent
  alias TeamJay.Investment.Feedback.Events

  def run do
    result = PortAgent.run(:daily_feedback)

    Events.daily(
      status: normalize_status(result),
      result: result
    )
  end

  defp normalize_status(:ok), do: :requested
  defp normalize_status(_other), do: :failed
end
