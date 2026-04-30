defmodule Luna.V2.Agents.Sentinel do
  @moduledoc """
  Shadow-only anomaly guard agent.
  """

  def inspect(metrics \\ %{}) do
    error_count = Map.get(metrics, :error_count, Map.get(metrics, "error_count", 0))
    latency_ms = Map.get(metrics, :latency_ms, Map.get(metrics, "latency_ms", 0))
    anomaly = error_count > 0 or latency_ms > 10_000

    %{
      agent: "sentinel",
      shadow: true,
      anomaly: anomaly,
      severity: if(anomaly, do: :warning, else: :ok)
    }
  end
end
