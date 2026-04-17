defmodule Jay.Core.Agents.LaunchdShadowAgent do
  @moduledoc "launchd 라벨 상태만 감시하는 Shadow GenServer."
  use GenServer
  require Logger

  defstruct [
    :name,
    :team,
    :label,
    :required,
    :status,
    :pid,
    :last_exit_code,
    :last_checked_at,
    :last_log_signature,
    :last_log_at
  ]

  @check_interval 30_000
  @log_cooldown_ms 300_000

  def child_spec(opts) do
    name = Keyword.fetch!(opts, :name)

    %{
      id: {:launchd_shadow_agent, name},
      start: {__MODULE__, :start_link, [opts]},
      restart: :permanent,
      shutdown: 5_000,
      type: :worker
    }
  end

  def start_link(opts) do
    name = Keyword.fetch!(opts, :name)
    GenServer.start_link(__MODULE__, opts, name: via(name))
  end

  def via(name), do: {:via, Registry, {TeamJay.AgentRegistry, {:launchd_shadow, name}}}

  def get_status(name), do: GenServer.call(via(name), :get_status)

  @impl true
  def init(opts) do
    state = %__MODULE__{
      name: Keyword.fetch!(opts, :name),
      team: Keyword.fetch!(opts, :team),
      label: Keyword.fetch!(opts, :label),
      required: Keyword.get(opts, :required, true),
      status: :unknown,
      pid: nil,
      last_exit_code: nil,
      last_checked_at: nil,
      last_log_signature: nil,
      last_log_at: nil
    }

    send(self(), :check)
    {:ok, state}
  end

  @impl true
  def handle_info(:check, state) do
    new_state = refresh_status(state)
    schedule_check()
    {:noreply, new_state}
  end

  @impl true
  def handle_call(:get_status, _from, state), do: {:reply, state, state}

  defp refresh_status(state) do
    case System.cmd("launchctl", ["list", state.label]) do
      {output, 0} ->
        parsed = parse_launchctl_detail(output)
        status = if(parsed.pid, do: :running, else: :loaded)

        maybe_log_status(state, status, state.label)

        %{
          state
          | status: status,
            pid: parsed.pid,
            last_exit_code: parsed.last_exit_code,
            last_checked_at: DateTime.utc_now()
        }

      {_output, _code} ->
        new_state = maybe_log_status(state, :missing, state.label)

        %{
          new_state
          | status: :missing,
            pid: nil,
            last_checked_at: DateTime.utc_now()
        }
    end
  end

  defp maybe_log_status(state, status, detail) do
    signature = "#{status}:#{detail}"
    now = System.monotonic_time(:millisecond)

    should_log =
      state.last_log_signature != signature or
        is_nil(state.last_log_at) or
        now - state.last_log_at >= @log_cooldown_ms

    if should_log do
      log_message =
        case status do
          :missing -> "[#{state.name}] launchd 미등록 또는 조회 실패: #{detail}"
          :running -> "[#{state.name}] launchd 실행 중: #{detail}"
          :loaded -> "[#{state.name}] launchd 로드됨: #{detail}"
          _ -> "[#{state.name}] launchd 상태 변경: #{status} #{detail}"
        end

      cond do
        status == :missing and state.required -> Logger.warning(log_message)
        status == :missing -> Logger.info(log_message)
        true -> Logger.debug(log_message)
      end

      %{state | last_log_signature: signature, last_log_at: now}
    else
      state
    end
  end

  defp parse_launchctl_detail(output) do
    pid =
      case Regex.run(~r/"pid"\s*=\s*(\d+)/, output) do
        [_, value] -> String.to_integer(value)
        _ -> nil
      end

    last_exit_code =
      case Regex.run(~r/"last exit code"\s*=\s*(\d+)/, output) do
        [_, value] -> String.to_integer(value)
        _ -> nil
      end

    %{pid: pid, last_exit_code: last_exit_code}
  end

  defp schedule_check, do: Process.send_after(self(), :check, @check_interval)
end
