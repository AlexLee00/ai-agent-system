defmodule TeamJay.EventListener do
  use GenServer
  require Logger

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    db_opts = [
      hostname: TeamJay.Config.db_host(),
      database: TeamJay.Config.db_name(),
      username: TeamJay.Config.db_user()
    ]

    db_opts =
      case TeamJay.Config.db_pass() do
        nil -> db_opts
        "" -> db_opts
        password -> Keyword.put(db_opts, :password, password)
      end

    channel = TeamJay.Config.pg_notify_channel()

    {:ok, pid} = Postgrex.Notifications.start_link(db_opts)
    {:ok, ref} = Postgrex.Notifications.listen(pid, channel)

    Logger.info("[EventListener] pg LISTEN 시작! channel=#{channel}")
    {:ok, %{pg_pid: pid, ref: ref, channel: channel, events: []}}
  end

  @impl true
  def handle_info({:notification, _pid, _ref, _channel, payload}, state) do
    event = Jason.decode!(payload)
    Logger.info("[EventListener] 이벤트 수신: #{event["event_type"]} (#{event["bot_name"]})")
    {:noreply, %{state | events: [event | Enum.take(state.events, 99)]}}
  end

  def get_recent(count \\ 10), do: GenServer.call(__MODULE__, {:get_recent, count})

  @impl true
  def handle_call({:get_recent, count}, _from, state) do
    {:reply, Enum.take(state.events, count), state}
  end
end

