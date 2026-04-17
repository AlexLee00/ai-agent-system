defmodule TeamJay.Claude.Dexter.ErrorTracker do
  @moduledoc """
  클로드팀 에러 추적기 — 실시간 에러 감지 + 패턴 분류

  EventLake에서 오는 port_agent_failed, system_error 이벤트를 구독하고:
  - 에러 누적 + 분류 (팀/파일/타입별)
  - 반복 패턴 감지 (동일 에러 3회↑ → 닥터 호출)
  - 에러 히스토리 관리 (최대 500개)
  """

  use GenServer
  require Logger

  alias Jay.Core.HubClient
  alias TeamJay.Claude.Topics

  @max_errors 500
  @repeat_threshold 3      # 동일 에러 N회 → 닥터 출동 트리거
  @pattern_window_ms 600_000  # 10분 윈도우에서 패턴 분석

  defstruct [
    errors: [],            # 최근 에러 목록
    patterns: %{},         # 패턴별 카운트: %{pattern_key => count}
    last_doctor_call: %{}, # 패턴별 마지막 닥터 호출 시각
    started_at: nil,
    pg_pid: nil,
    ref: nil
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  # ── Public API ──────────────────────────────────────────────────────

  def get_errors(limit \\ 50) do
    GenServer.call(__MODULE__, {:get_errors, limit})
  end

  def get_patterns do
    GenServer.call(__MODULE__, :get_patterns)
  end

  def get_summary do
    GenServer.call(__MODULE__, :get_summary)
  end

  # ── GenServer ───────────────────────────────────────────────────────

  @impl true
  def init(_opts) do
    db_opts = Jay.Core.Config.notification_db_opts()
    channel = Jay.Core.Config.pg_notify_channel()

    {:ok, pid} = Postgrex.Notifications.start_link(db_opts)
    {:ok, ref} = Postgrex.Notifications.listen(pid, channel)

    Logger.info("[ErrorTracker] 에러 추적 시작! channel=#{channel}")

    {:ok, %__MODULE__{
      started_at: DateTime.utc_now(),
      pg_pid: pid,
      ref: ref
    }}
  end

  @impl true
  def handle_info({:notification, _pid, _ref, _channel, payload}, state) do
    case Jason.decode(payload) do
      {:ok, event} -> {:noreply, process_event(event, state)}
      _ -> {:noreply, state}
    end
  end

  @impl true
  def handle_call({:get_errors, limit}, _from, state) do
    {:reply, Enum.take(state.errors, limit), state}
  end

  def handle_call(:get_patterns, _from, state) do
    {:reply, state.patterns, state}
  end

  def handle_call(:get_summary, _from, state) do
    summary = %{
      total_errors: length(state.errors),
      hot_patterns: top_patterns(state.patterns, 5),
      uptime_min: div(DateTime.diff(DateTime.utc_now(), state.started_at), 60)
    }
    {:reply, summary, state}
  end

  # ── 이벤트 처리 ────────────────────────────────────────────────────

  defp process_event(%{"event_type" => type} = event, state)
       when type in ["port_agent_failed", "system_error", "error", "agent_error"] do
    Logger.warning("[ErrorTracker] 에러 감지: #{type} (#{event["bot_name"]})")

    error_entry = %{
      event_type: type,
      bot_name:   event["bot_name"] || "unknown",
      team:       event["team"] || "unknown",
      message:    event["title"] || event["message"] || "",
      data:       event["data"],
      ts:         System.monotonic_time(:millisecond)
    }

    new_errors   = [error_entry | Enum.take(state.errors, @max_errors - 1)]
    pattern_key  = "#{error_entry.bot_name}:#{error_entry.event_type}"
    new_patterns = Map.update(state.patterns, pattern_key, 1, & &1 + 1)

    new_state = %{state | errors: new_errors, patterns: new_patterns}

    # 반복 패턴 감지 → 닥터 트리거
    new_state = maybe_trigger_doctor(pattern_key, new_patterns[pattern_key], error_entry, new_state)

    # Claude Topics broadcast
    Jay.Core.JayBus |> Registry.dispatch(Topics.error_detected(), fn entries ->
      Enum.each(entries, fn {pid, _} -> send(pid, {:claude_event, Topics.error_detected(), error_entry}) end)
    end)

    new_state
  end

  defp process_event(_event, state), do: state

  defp maybe_trigger_doctor(pattern_key, count, error_entry, state) do
    last_call = Map.get(state.last_doctor_call, pattern_key, 0)
    now = System.monotonic_time(:millisecond)

    if count >= @repeat_threshold and (now - last_call) > @pattern_window_ms do
      Logger.warning("[ErrorTracker] 반복 에러 감지! #{pattern_key} (#{count}회) → 닥터 호출")

      Task.start(fn ->
        HubClient.post_alarm(
          "🔴 반복 에러 감지!\n봇: #{error_entry.bot_name}\n패턴: #{pattern_key}\n횟수: #{count}회\n마지막: #{error_entry.message}",
          error_entry.bot_name, "claude"
        )
      end)

      %{state | last_doctor_call: Map.put(state.last_doctor_call, pattern_key, now)}
    else
      state
    end
  end

  defp top_patterns(patterns, n) do
    patterns
    |> Enum.sort_by(fn {_k, v} -> -v end)
    |> Enum.take(n)
    |> Map.new()
  end
end
