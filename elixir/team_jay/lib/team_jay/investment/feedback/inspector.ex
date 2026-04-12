defmodule TeamJay.Investment.Feedback.Inspector do
  @moduledoc """
  투자팀 피드백 scaffold 상태 점검 helper.

  realtime feedback worker의 registry 상태와 내부 snapshot을 한 번에 확인한다.
  """

  alias TeamJay.Investment.Feedback.Realtime
  alias TeamJay.Investment.PipelineStarter

  def inspect_symbol(symbol) do
    registry = lookup({:investment_feedback_realtime, symbol})

    %{
      symbol: symbol,
      realtime: registry,
      status: fetch_status(symbol, registry)
    }
  end

  def inspect_defaults do
    PipelineStarter.default_pipelines()
    |> Enum.map(fn %{symbol: symbol} = item ->
      Map.put(item, :feedback_status, inspect_symbol(symbol))
    end)
  end

  defp fetch_status(symbol, %{registered: true}) do
    Realtime.status(symbol)
  rescue
    _error -> %{status: :unavailable}
  end

  defp fetch_status(_symbol, %{registered: false}), do: %{status: :not_started}

  defp lookup(key) do
    case Registry.lookup(TeamJay.AgentRegistry, key) do
      [{pid, _meta}] ->
        %{
          registered: true,
          pid: inspect(pid),
          alive: Process.alive?(pid),
          key: key
        }

      [] ->
        %{
          registered: false,
          pid: nil,
          alive: false,
          key: key
        }
    end
  end

end
