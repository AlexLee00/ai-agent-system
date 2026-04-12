defmodule TeamJay.Investment.Feedback.Daily do
  @moduledoc """
  투자팀 일일 피드백 호출 스캐폴드.

  현재 운영 중인 Node.js daily_feedback PortAgent를 감싸는 얇은 인터페이스다.
  향후 일일 피드백 로직을 Elixir 네이티브로 옮길 때 교체 지점으로 사용한다.
  """

  alias TeamJay.Agents.PortAgent

  def run, do: PortAgent.run(:daily_feedback)
end
