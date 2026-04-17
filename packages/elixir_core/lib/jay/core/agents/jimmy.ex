defmodule Jay.Core.Agents.Jimmy do
  use GenServer
  require Logger

  @check_interval 120_000

  defstruct [:name, :team, :status, :last_check, :check_count]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    Logger.info("[Jimmy] 시작!")
    schedule_check()
    {:ok, %__MODULE__{name: "jimmy", team: "ska", status: :idle, last_check: nil, check_count: 0}}
  end

  @impl true
  def handle_info(:health_check, state) do
    Logger.debug("[Jimmy] 체크 ##{state.check_count + 1}")
    schedule_check()
    {:noreply, %{state | status: :ok, last_check: DateTime.utc_now(), check_count: state.check_count + 1}}
  end

  defp schedule_check, do: Process.send_after(self(), :health_check, @check_interval)
  def get_status, do: GenServer.call(__MODULE__, :get_status)

  @impl true
  def handle_call(:get_status, _from, state), do: {:reply, state, state}
end

