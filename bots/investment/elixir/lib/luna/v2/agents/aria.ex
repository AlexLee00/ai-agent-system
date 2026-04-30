defmodule Luna.V2.Agents.Aria do
  @moduledoc """
  Shadow-only technical analysis agent.
  """

  def score(indicators \\ %{}) do
    rsi = Map.get(indicators, :rsi, Map.get(indicators, "rsi", 50))
    macd = Map.get(indicators, :macd_histogram, Map.get(indicators, "macd_histogram", 0))
    direction =
      cond do
        rsi < 35 and macd >= 0 -> :bullish_watch
        rsi > 70 and macd < 0 -> :bearish_watch
        true -> :neutral
      end

    %{agent: "aria", shadow: true, direction: direction, confidence: 0.5}
  end
end
