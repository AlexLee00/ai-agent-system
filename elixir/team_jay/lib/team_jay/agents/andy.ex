defmodule TeamJay.Agents.Andy do
  use GenServer
  require Logger

  @check_interval 60_000

  defstruct [:name, :team, :status, :last_check, :check_count, :errors]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    Logger.info("[Andy] 시작! 1분 간격 헬스 체크!")
    schedule_check()

    {:ok,
     %__MODULE__{
       name: "andy",
       team: "ska",
       status: :idle,
       last_check: nil,
       check_count: 0,
       errors: []
     }}
  end

  @impl true
  def handle_info(:health_check, state) do
    new_state = do_health_check(state)
    schedule_check()
    {:noreply, new_state}
  end

  defp do_health_check(state) do
    case TeamJay.HubClient.health() do
      {:ok, _} ->
        Logger.debug("[Andy] 헬스 체크 OK (##{state.check_count + 1})")
        %{state | status: :ok, last_check: DateTime.utc_now(), check_count: state.check_count + 1}

      {:error, err} ->
        Logger.warning("[Andy] 헬스 체크 실패: #{inspect(err)}")

        %{
          state
          | status: :error,
            last_check: DateTime.utc_now(),
            check_count: state.check_count + 1,
            errors: [err | Enum.take(state.errors, 9)]
        }
    end
  end

  defp schedule_check, do: Process.send_after(self(), :health_check, @check_interval)
  def get_status, do: GenServer.call(__MODULE__, :get_status)

  @impl true
  def handle_call(:get_status, _from, state), do: {:reply, state, state}
end

