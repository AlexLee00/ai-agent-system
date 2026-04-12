defmodule TeamJay.Investment.Feedback.Events do
  @moduledoc """
  투자팀 피드백 레이어 공용 payload 헬퍼.

  실시간/일일 피드백이 같은 키 구조를 공유하도록 만든다.
  """

  def realtime(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :feedback_realtime_scaffold,
        generated_at: DateTime.utc_now(),
        evaluation: %{status: :observed, score: 0.0}
      },
      Map.new(attrs)
    )
  end

  def daily(attrs \\ %{}) do
    Map.merge(
      %{
        source: :feedback_daily_scaffold,
        generated_at: DateTime.utc_now(),
        status: :requested
      },
      Map.new(attrs)
    )
  end
end
