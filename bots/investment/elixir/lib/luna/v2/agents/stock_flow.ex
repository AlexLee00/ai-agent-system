defmodule Luna.V2.Agents.StockFlow do
  @moduledoc """
  Shadow-only stock/volume flow agent.
  """

  def analyze(event \\ %{}) do
    volume_ratio = Map.get(event, :volume_ratio, Map.get(event, "volume_ratio", 1.0))
    pressure =
      cond do
        volume_ratio >= 2.0 -> :accumulation_watch
        volume_ratio <= 0.5 -> :distribution_watch
        true -> :neutral
      end

    %{
      agent: "stock-flow",
      shadow: true,
      pressure: pressure,
      confidence: min(1.0, max(0.0, volume_ratio / 3.0))
    }
  end
end
