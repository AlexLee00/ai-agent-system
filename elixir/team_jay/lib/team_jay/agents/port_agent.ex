defmodule TeamJay.Agents.PortAgent do
  @moduledoc "기존 Node.js 스크립트를 Port로 감싸는 공용 GenServer."
  use GenServer
  require Logger

  defstruct [
    :name,
    :team,
    :script,
    :runner,
    :schedule,
    :health_url,
    :port,
    :status,
    :last_run,
    :runs,
    :last_output,
    :consecutive_failures,
    :last_alert_at
  ]

  @alert_failure_threshold 3
  @alert_cooldown_seconds 900

  def child_spec(opts) do
    name = Keyword.fetch!(opts, :name)

    %{
      id: {:port_agent, name},
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

  def via(name), do: {:via, Registry, {TeamJay.AgentRegistry, name}}

  def run(name), do: GenServer.cast(via(name), :run)
  def stop(name), do: GenServer.cast(via(name), :stop)
  def get_status(name), do: GenServer.call(via(name), :get_status)

  @impl true
  def init(opts) do
    name = Keyword.fetch!(opts, :name)
    team = Keyword.fetch!(opts, :team)
    script = Keyword.fetch!(opts, :script)
    runner = Keyword.get(opts, :runner, :node)
    schedule = Keyword.get(opts, :schedule)
    health_url = Keyword.get(opts, :health_url)

    Logger.info("[#{name}] 시작!")
    record_event(:info, "#{name} 시작", "port_agent_started", team, name, %{
      script: script,
      runner: runner_to_string(runner),
      schedule: schedule_to_string(schedule)
    })
    if schedule == :once, do: send(self(), :run)
    if match?({:interval, _}, schedule) or match?({:daily_at, _, _}, schedule) or match?({:weekly_at, _, _, _}, schedule),
      do: schedule_run(schedule)

    {:ok,
     %__MODULE__{
       name: name,
        team: team,
        script: script,
        runner: runner,
        schedule: schedule,
        health_url: health_url,
        port: nil,
        status: :idle,
        last_run: nil,
       runs: 0,
       last_output: [],
       consecutive_failures: 0,
       last_alert_at: nil
     }}
  end

  @impl true
  def handle_info(:run, state) do
    new_state = execute_script(state)
    if match?({:interval, _}, state.schedule) or match?({:daily_at, _, _}, state.schedule) or match?({:weekly_at, _, _, _}, state.schedule),
      do: schedule_run(state.schedule)
    {:noreply, new_state}
  end

  def handle_info({port, {:data, data}}, %{port: port} = state) do
    line = String.trim(to_string(data))
    Logger.debug("[#{state.name}] #{line}")

    new_output =
      [line | state.last_output]
      |> Enum.reject(&(&1 == ""))
      |> Enum.take(20)

    {:noreply, %{state | last_output: new_output}}
  end

  def handle_info({port, {:exit_status, code}}, %{port: port} = state) do
    if code == 0 do
      Logger.info("[#{state.name}] 완료! (runs: #{state.runs + 1})")
      record_event(:info, "#{state.name} 완료", "port_agent_completed", state.team, state.name, %{
        script: state.script,
        runs: state.runs + 1,
        output_summary: summarize_output(state.last_output)
      })

      new_state = %{
        state
        | port: nil,
          status: :idle,
          runs: state.runs + 1,
          last_output: [],
          consecutive_failures: 0
      }

      {:noreply, new_state}
    else
      Logger.warning("[#{state.name}] 종료 코드: #{code}")
      failure_count = state.consecutive_failures + 1
      output_summary = summarize_output(state.last_output)

      record_event(:warn, "#{state.name} 실패", "port_agent_failed", state.team, state.name, %{
        script: state.script,
        exit_code: code,
        runs: state.runs + 1,
        consecutive_failures: failure_count,
        output_summary: output_summary
      })

      alert_time =
        maybe_send_failure_alarm(%{
          name: state.name,
          team: state.team,
          script: state.script,
          exit_code: code,
          consecutive_failures: failure_count,
          output_summary: output_summary,
          last_alert_at: state.last_alert_at
        })

      new_state = %{
        state
        | port: nil,
          status: :idle,
          runs: state.runs + 1,
          last_output: [],
          consecutive_failures: failure_count,
          last_alert_at: alert_time || state.last_alert_at
      }

      {:noreply, new_state}
    end
  end

  @impl true
  def handle_cast(:run, state) do
    {:noreply, execute_script(state)}
  end

  @impl true
  def handle_cast(:stop, %{port: nil} = state) do
    {:noreply, %{state | status: :idle}}
  end

  @impl true
  def handle_cast(:stop, %{port: port} = state) do
    _ = safe_close_port(port)
    {:noreply, %{state | port: nil, status: :idle, last_output: []}}
  end

  @impl true
  def handle_call(:get_status, _from, state), do: {:reply, state, state}

  defp execute_script(%{port: nil} = state) do
    if skip_daemon_boot?(state) do
      Logger.info("[#{state.name}] 실행 생략: 이미 health 응답 중")
      record_event(:info, "#{state.name} 실행 생략", "port_agent_skipped", state.team, state.name, %{
        script: state.script,
        runner: runner_to_string(state.runner),
        schedule: schedule_to_string(state.schedule),
        health_url: state.health_url,
        reason: "already_healthy"
      })

      %{state | status: :idle}
    else
    Logger.info("[#{state.name}] 실행: #{state.script}")
    record_event(:info, "#{state.name} 실행", "port_agent_run", state.team, state.name, %{
      script: state.script,
      runner: runner_to_string(state.runner),
      schedule: schedule_to_string(state.schedule),
      runs: state.runs
    })

    port = open_port(state)

    %{state | port: port, status: :running, last_run: DateTime.utc_now()}
    end
  end

  defp execute_script(state), do: state

  defp skip_daemon_boot?(%{schedule: :once, health_url: health_url}) when is_binary(health_url) do
    case Req.get(health_url) do
      {:ok, %{status: 200}} -> true
      _ -> false
    end
  rescue
    _ -> false
  end

  defp skip_daemon_boot?(_state), do: false

  defp open_port(%{runner: :node, script: script}) do
    Port.open({:spawn_executable, System.find_executable("node")}, [
      :binary,
      :exit_status,
      :stderr_to_stdout,
      args: String.split(script, " ", trim: true),
      cd: TeamJay.Config.repo_root(),
      env: port_env()
    ])
  end

  defp open_port(%{runner: {:shell, shell}, script: script}) do
    Port.open({:spawn_executable, shell}, [
      :binary,
      :exit_status,
      :stderr_to_stdout,
      args: ["-lc", script],
      cd: TeamJay.Config.repo_root(),
      env: port_env()
    ])
  end

  defp safe_close_port(port) do
    Port.close(port)
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  defp port_env do
    [
      {~c"MODE", ~c"ops"},
      {~c"PROJECT_ROOT", String.to_charlist(TeamJay.Config.repo_root())}
    ]
  end

  defp schedule_run({:interval, ms}), do: Process.send_after(self(), :run, ms)
  defp schedule_run({:daily_at, hour, minute}) do
    now = NaiveDateTime.local_now() |> NaiveDateTime.truncate(:second)
    date = NaiveDateTime.to_date(now)
    {:ok, time} = Time.new(hour, minute, 0)
    {:ok, today_target} = NaiveDateTime.new(date, time)

    next_target =
      if NaiveDateTime.compare(today_target, now) == :gt do
        today_target
      else
        {:ok, tomorrow_target} = NaiveDateTime.new(Date.add(date, 1), time)
        tomorrow_target
      end

    delay_ms = max(NaiveDateTime.diff(next_target, now, :millisecond), 0)
    Process.send_after(self(), :run, delay_ms)
  end
  defp schedule_run({:weekly_at, weekdays, hour, minute}) do
    now = NaiveDateTime.local_now() |> NaiveDateTime.truncate(:second)
    date = NaiveDateTime.to_date(now)
    {:ok, time} = Time.new(hour, minute, 0)

    normalized_weekdays =
      weekdays
      |> List.wrap()
      |> Enum.uniq()
      |> Enum.sort()

    next_target =
      0..7
      |> Enum.find_value(fn offset ->
        target_date = Date.add(date, offset)
        target_weekday = Date.day_of_week(target_date)

        if target_weekday in normalized_weekdays do
          {:ok, candidate} = NaiveDateTime.new(target_date, time)

          if offset > 0 or NaiveDateTime.compare(candidate, now) == :gt do
            candidate
          end
        end
      end)

    delay_ms = max(NaiveDateTime.diff(next_target, now, :millisecond), 0)
    Process.send_after(self(), :run, delay_ms)
  end

  defp record_event(severity, title, event_type, team, bot_name, metadata) do
    TeamJay.EventLake.record(%{
      event_type: event_type,
      team: Atom.to_string(team),
      bot_name: Atom.to_string(bot_name),
      severity: Atom.to_string(severity),
      title: title,
      message: title,
      tags: ["phase3", "port_agent", "team:#{team}"],
      metadata: metadata
    })
  end

  defp schedule_to_string(nil), do: "manual"
  defp schedule_to_string(:once), do: "once"
  defp schedule_to_string({:interval, ms}), do: "interval:#{ms}"
  defp schedule_to_string({:daily_at, hour, minute}),
    do: "daily_at:" <> String.pad_leading(Integer.to_string(hour), 2, "0") <> ":" <> String.pad_leading(Integer.to_string(minute), 2, "0")
  defp schedule_to_string({:weekly_at, weekdays, hour, minute}),
    do:
      "weekly_at:"
      <> (weekdays |> List.wrap() |> Enum.map_join(",", &Integer.to_string/1))
      <> "@"
      <> String.pad_leading(Integer.to_string(hour), 2, "0")
      <> ":"
      <> String.pad_leading(Integer.to_string(minute), 2, "0")

  defp runner_to_string(:node), do: "node"
  defp runner_to_string({:shell, shell}), do: "shell:" <> shell

  defp summarize_output(lines) do
    lines
    |> Enum.reverse()
    |> Enum.join("\n")
    |> String.slice(0, 2_000)
  end

  defp maybe_send_failure_alarm(%{
         name: name,
         team: team,
         script: script,
         exit_code: code,
         consecutive_failures: failures,
         output_summary: output_summary,
         last_alert_at: last_alert_at
       }) do
    now = DateTime.utc_now()

    if failures >= @alert_failure_threshold and alert_due?(last_alert_at, now) do
      summary =
        output_summary
        |> String.replace("\n", " | ")
        |> String.slice(0, 500)

      _ =
        TeamJay.HubClient.post_alarm(
          "🚨 Phase3 PortAgent 연속 실패\n에이전트: #{name}\n팀: #{team}\n종료코드: #{code}\n연속 실패: #{failures}\n스크립트: #{script}\n출력: #{summary}",
          Atom.to_string(team),
          "team-jay"
        )

      now
    else
      nil
    end
  end

  defp alert_due?(nil, _now), do: true

  defp alert_due?(last_alert_at, now) do
    DateTime.diff(now, last_alert_at, :second) >= @alert_cooldown_seconds
  end
end
