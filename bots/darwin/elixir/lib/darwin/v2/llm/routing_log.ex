defmodule Darwin.V2.LLM.RoutingLog do
  @moduledoc """
  다윈 V2 LLM 라우팅 기록 — 공용 레이어 + GenServer 비동기 기록.

  DB: darwin_v2_llm_routing_log 테이블
  GenServer: 비동기 기록 + 최근 실패율 조회.
  """

  use GenServer
  require Logger

  @table "darwin_v2_llm_routing_log"
  @log_prefix "[다윈V2/routing_log]"

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, Keyword.merge([name: __MODULE__], opts))
  end

  @doc "라우팅 시도 기록 — 비동기 cast."
  def record(entry) do
    GenServer.cast(__MODULE__, {:record, entry})
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end

  @doc "에이전트별 최근 24h 실패율 (0.0~1.0)."
  def recent_failure_rate(agent_name) do
    GenServer.call(__MODULE__, {:recent_failure_rate, to_string(agent_name)})
  rescue
    _ -> 0.0
  catch
    :exit, _ -> 0.0
  end

  @impl true
  def init(:ok), do: {:ok, %{}}

  @impl true
  def handle_cast({:record, entry}, state) do
    Jay.Core.LLM.RoutingLog.Impl.record(@table, @log_prefix, entry)
    {:noreply, state}
  end

  @impl true
  def handle_call({:recent_failure_rate, agent_name}, _from, state) do
    rate = Jay.Core.LLM.RoutingLog.Impl.recent_failure_rate(@table, agent_name)
    {:reply, rate, state}
  end
end
