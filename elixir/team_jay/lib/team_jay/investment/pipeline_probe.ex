defmodule TeamJay.Investment.PipelineProbe do
  @moduledoc """
  투자팀 Elixir scaffold 파이프라인을 안전하게 확인하는 probe helper.

  운영 메인 경로에 연결하지 않고 단일 심볼 pipeline을 선택적으로 띄운 뒤
  현재 worker registry 상태를 한 번에 반환한다.
  """

  alias TeamJay.Investment.PipelineDynamicSupervisor
  alias TeamJay.Investment.PipelineInspector
  alias TeamJay.Investment.PipelineStarter

  @default_interval_ms 250

  def probe(opts \\ []) do
    exchange = Keyword.get(opts, :exchange, "binance")
    symbol = Keyword.get(opts, :symbol, "BTC/USDT")
    interval_ms = Keyword.get(opts, :interval_ms, @default_interval_ms)
    stop_after_probe? = Keyword.get(opts, :stop_after_probe, true)

    ensure_dynamic_supervisor!()

    start_result =
      case PipelineStarter.start_pipeline(exchange: exchange, symbol: symbol, interval_ms: interval_ms) do
        {:ok, pid} -> %{status: :started, pid: inspect(pid)}
        {:error, {:already_started, pid}} -> %{status: :already_started, pid: inspect(pid)}
        other -> %{status: :failed_to_start, error: inspect(other)}
      end

    inspection = PipelineInspector.inspect_symbol(exchange, symbol)

    if stop_after_probe? and start_result.status in [:started, :already_started] do
      _ = PipelineStarter.stop_pipeline(exchange, symbol)
    end

    %{
      exchange: exchange,
      symbol: symbol,
      interval_ms: interval_ms,
      stop_after_probe: stop_after_probe?,
      start_result: start_result,
      inspection: inspection
    }
  end

  def probe_defaults(opts \\ []) do
    stop_after_probe? = Keyword.get(opts, :stop_after_probe, true)
    interval_ms = Keyword.get(opts, :interval_ms, @default_interval_ms)

    Enum.map(PipelineStarter.default_pipelines(), fn %{exchange: exchange, symbol: symbol} ->
      probe(
        exchange: exchange,
        symbol: symbol,
        interval_ms: interval_ms,
        stop_after_probe: stop_after_probe?
      )
    end)
  end

  defp ensure_dynamic_supervisor! do
    case Process.whereis(PipelineDynamicSupervisor) do
      nil ->
        {:ok, _pid} = PipelineDynamicSupervisor.start_link([])
        :ok

      _pid ->
        :ok
    end
  end
end
