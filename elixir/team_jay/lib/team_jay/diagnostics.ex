defmodule TeamJay.Diagnostics do
  @moduledoc """
  BEAM 프로세스 상태 점검 + 이상 알림.
  """
  use GenServer
  require Logger

  @check_interval 30_000
  @msg_queue_warn 100
  @memory_warn 100_000_000
  @phase3_launchd_labels [
    "ai.ska.naver-monitor",
    "ai.ska.kiosk-monitor",
    "ai.ska.commander",
    "ai.ska.eve",
    "ai.ska.eve-crawl",
    "ai.ska.etl",
    "ai.ska.rebecca",
    "ai.ska.forecast-daily",
    "ai.ska.forecast-weekly",
    "ai.ska.forecast-monthly",
    "ai.ska.pickko-daily-audit",
    "ai.ska.pickko-daily-summary",
    "ai.ska.pickko-verify",
    "ai.ska.today-audit",
    "ai.ska.health-check",
    "ai.ska.log-report",
    "ai.ska.log-rotate",
    "ai.ska.db-backup",
    "ai.claude.dexter",
    "ai.claude.dexter.daily",
    "ai.claude.dexter.quick",
    "ai.claude.commander",
    "ai.claude.archer",
    "ai.claude.health-check",
    "ai.claude.health-dashboard",
    "ai.claude.speed-test",
    "ai.steward.hourly",
    "ai.steward.daily",
    "ai.steward.weekly"
  ]
  @shadow_agents [
    {:andy, :ska},
    {:jimmy, :ska},
    {:ska_commander, :ska},
    {:dexter, :claude},
    {:claude_commander, :claude},
    {:steward_hourly, :steward},
    {:steward_daily, :steward}
  ]
  @week2_shadow_agents [
    {:luna_commander, :investment},
    {:luna_domestic, :investment},
    {:luna_overseas, :investment},
    {:luna_crypto, :investment},
    {:argos_shadow, :investment},
    {:reporter_shadow, :investment},
    {:blog_daily, :blog},
    {:blog_commenter, :blog},
    {:blog_node_server, :blog}
  ]
  @week3_shadow_agents [
    {:worker_lead, :worker},
    {:worker_task_runner, :worker},
    {:worker_web, :worker},
    {:worker_nextjs, :worker},
    {:worker_health_check, :worker},
    {:worker_claude_monitor, :worker},
    {:darwin_orchestrator, :platform},
    {:hub_resource_api, :platform}
  ]

  defstruct [:checks, :alerts, :last_check, :last_overlap_signature]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    Logger.info("[Diagnostics] BEAM 모니터링 시작!")
    schedule_check()
    {:ok, %__MODULE__{checks: [], alerts: [], last_check: nil, last_overlap_signature: nil}}
  end

  @impl true
  def handle_info(:check, state) do
    results = run_diagnostics()
    alerts = Enum.filter(results, &(&1.severity in [:warn, :error]))
    overlap_signature = maybe_record_launchd_overlap(results, state.last_overlap_signature)

    if length(alerts) > 0 do
      Logger.warning("[Diagnostics] #{length(alerts)}건 경고!")
      Enum.each(alerts, fn alert -> Logger.warning("  ⚠️ #{alert.name}: #{alert.message}") end)

      msg =
        alerts
        |> Enum.map(&("⚠️ #{&1.name}: #{&1.message}"))
        |> Enum.join("\n")

      _ = TeamJay.HubClient.post_alarm("🔍 Elixir 진단 경고!\n#{msg}", "claude", "diagnostics")
    end

    schedule_check()

    {:noreply,
     %{
       state
       | checks: results,
         alerts: alerts,
         last_check: DateTime.utc_now(),
         last_overlap_signature: overlap_signature
     }}
  end

  def get_status, do: GenServer.call(__MODULE__, :get_status)
  def shadow_report, do: GenServer.call(__MODULE__, :shadow_report)
  def publish_shadow_report, do: GenServer.call(__MODULE__, :publish_shadow_report)

  @impl true
  def handle_call(:get_status, _from, state), do: {:reply, state, state}

  @impl true
  def handle_call(:shadow_report, _from, state) do
    {:reply, build_shadow_report(state), state}
  end

  @impl true
  def handle_call(:publish_shadow_report, _from, state) do
    report = build_shadow_report(state)

    severity =
      if(
        report.overlap_count > 0 or report.summary.failing > 0 or
          report.week2_summary.required_missing > 0 or report.week3_summary.required_missing > 0,
        do: "warn",
        else: "info"
      )

    TeamJay.EventLake.record(%{
      event_type: "phase3_shadow_report",
      team: "system",
      bot_name: "diagnostics",
      severity: severity,
      title: "Phase3 Shadow 리포트",
      message:
        "겹침 #{report.overlap_count}건 | failing #{report.summary.failing} | missing #{report.summary.missing}",
      tags: ["phase3", "diagnostics", "shadow_report"],
      metadata: report
    })

    maybe_alarm_shadow_report(report, severity)

    {:reply, report, state}
  end

  defp run_diagnostics do
    [
      check_process_count(),
      check_memory(),
      check_supervisors(),
      check_message_queues(),
      check_launchd_overlap()
    ]
    |> List.flatten()
  end

  defp check_process_count do
    count = :erlang.system_info(:process_count)
    limit = :erlang.system_info(:process_limit)

    %{
      name: "process_count",
      value: count,
      limit: limit,
      severity: if(count > limit * 0.8, do: :warn, else: :ok),
      message: "#{count}/#{limit} (#{Float.round(count / limit * 100, 1)}%)"
    }
  end

  defp check_memory do
    mem = :erlang.memory()
    total = mem[:total]

    %{
      name: "memory_total",
      value: total,
      severity: if(total > @memory_warn, do: :warn, else: :ok),
      message: "#{Float.round(total / 1_000_000, 1)}MB"
    }
  end

  defp check_supervisors do
    supervisors = [
      TeamJay.Teams.SkaSupervisor,
      TeamJay.Teams.ClaudeSupervisor,
      TeamJay.Teams.StewardSupervisor,
      TeamJay.Teams.InvestmentShadowSupervisor,
      TeamJay.Teams.BlogShadowSupervisor,
      TeamJay.Teams.WorkerShadowSupervisor,
      TeamJay.Teams.PlatformShadowSupervisor
    ]

    Enum.map(supervisors, fn sup ->
      case Process.whereis(sup) do
        nil ->
          %{name: "supervisor_#{inspect(sup)}", severity: :error, message: "프로세스 없음!"}

        pid ->
          children = Supervisor.count_children(pid)

          %{
            name: "supervisor_#{inspect(sup)}",
            severity: :ok,
            message: "active=#{children[:active]} workers=#{children[:workers]}"
          }
      end
    end)
  end

  defp check_message_queues do
    processes = [
      TeamJay.EventLake,
      TeamJay.MarketRegime,
      TeamJay.Agents.PortAgent.via(:andy),
      TeamJay.Agents.PortAgent.via(:jimmy),
      TeamJay.Agents.PortAgent.via(:dexter)
    ]

    Enum.map(processes, fn mod ->
      case GenServer.whereis(mod) do
        nil ->
          %{name: "msgq_#{inspect(mod)}", severity: :warn, message: "프로세스 없음"}

        pid ->
          {:message_queue_len, len} = Process.info(pid, :message_queue_len)

          %{
            name: "msgq_#{inspect(mod)}",
            value: len,
            severity: if(len > @msg_queue_warn, do: :warn, else: :ok),
            message: "큐=#{len}"
          }
      end
    end)
  end

  defp check_launchd_overlap do
    case System.cmd("launchctl", ["list"]) do
      {output, 0} ->
        loaded =
          output
          |> String.split("\n", trim: true)
          |> Enum.map(&String.split(&1, "\t", trim: true))
          |> Enum.filter(&(length(&1) == 3))
          |> Enum.map(&Enum.at(&1, 2))
          |> MapSet.new()

        overlaps =
          @phase3_launchd_labels
          |> Enum.filter(&MapSet.member?(loaded, &1))

        [
          %{
            name: "launchd_phase3_overlap",
            severity: if(overlaps == [], do: :ok, else: :warn),
            message: "겹침 #{length(overlaps)}건",
            overlaps: overlaps
          }
        ]

      {error, code} ->
        [
          %{
            name: "launchd_phase3_overlap",
            severity: :warn,
            message: "launchctl 조회 실패 code=#{code} #{String.slice(error, 0, 120)}"
          }
        ]
    end
  end

  defp maybe_record_launchd_overlap(results, last_signature) do
    overlap_result = Enum.find(results, &(&1.name == "launchd_phase3_overlap"))

    signature =
      case overlap_result do
        nil -> "missing"
        %{overlaps: overlaps} -> Enum.sort(overlaps) |> Enum.join(",")
        %{message: message} -> message
      end

    if signature != last_signature do
      record_launchd_overlap_event(overlap_result, signature)
    end

    signature
  end

  defp build_shadow_report(state) do
    overlap_result = Enum.find(state.checks, &(&1.name == "launchd_phase3_overlap")) || %{}

    agent_statuses =
      Enum.map(@shadow_agents, fn {name, team} ->
        case GenServer.whereis(TeamJay.Agents.PortAgent.via(name)) do
          nil ->
            %{name: name, team: team, status: :missing, runs: 0, consecutive_failures: 0}

          _pid ->
            status = TeamJay.Agents.PortAgent.get_status(name)

            %{
              name: name,
              team: team,
              status: status.status,
              runs: status.runs,
              consecutive_failures: Map.get(status, :consecutive_failures, 0)
            }
        end
      end)

    week2_shadow_agents = build_launchd_shadow_agents(@week2_shadow_agents)
    week3_shadow_agents = build_launchd_shadow_agents(@week3_shadow_agents)

    summary = %{
      total: length(agent_statuses),
      running: Enum.count(agent_statuses, &(&1.status == :running)),
      idle: Enum.count(agent_statuses, &(&1.status == :idle)),
      missing: Enum.count(agent_statuses, &(&1.status == :missing)),
      failing: Enum.count(agent_statuses, &(&1.consecutive_failures > 0))
    }

    week2_summary = %{
      total: length(week2_shadow_agents),
      running: Enum.count(week2_shadow_agents, &(&1.status == :running)),
      loaded: Enum.count(week2_shadow_agents, &(&1.status == :loaded)),
      missing: Enum.count(week2_shadow_agents, &(&1.status == :missing)),
      required_missing:
        Enum.count(week2_shadow_agents, &(&1.status == :missing and Map.get(&1, :required, true))),
      optional_missing:
        Enum.count(week2_shadow_agents, &(&1.status == :missing and not Map.get(&1, :required, true)))
    }

    week3_summary = %{
      total: length(week3_shadow_agents),
      running: Enum.count(week3_shadow_agents, &(&1.status == :running)),
      loaded: Enum.count(week3_shadow_agents, &(&1.status == :loaded)),
      missing: Enum.count(week3_shadow_agents, &(&1.status == :missing)),
      required_missing:
        Enum.count(week3_shadow_agents, &(&1.status == :missing and Map.get(&1, :required, true))),
      optional_missing:
        Enum.count(week3_shadow_agents, &(&1.status == :missing and not Map.get(&1, :required, true)))
    }

    %{
      generated_at: DateTime.utc_now(),
      overlap_count: length(Map.get(overlap_result, :overlaps, [])),
      overlaps: Map.get(overlap_result, :overlaps, []),
      supervisor_alerts: Enum.map(state.alerts, &Map.take(&1, [:name, :severity, :message])),
      agents: agent_statuses,
      week2_shadow_agents: week2_shadow_agents,
      week2_summary: week2_summary,
      week3_shadow_agents: week3_shadow_agents,
      week3_summary: week3_summary,
      summary: summary,
      recent_failures: TeamJay.EventLake.get_by_type("port_agent_failed", 5)
    }
  end

  defp build_launchd_shadow_agents(agents) do
    Enum.map(agents, fn {name, team} ->
      case GenServer.whereis(TeamJay.Agents.LaunchdShadowAgent.via(name)) do
        nil ->
          %{
            name: name,
            team: team,
            status: :missing,
            pid: nil,
            last_exit_code: nil,
            required: true
          }

        _pid ->
          status = TeamJay.Agents.LaunchdShadowAgent.get_status(name)

          %{
            name: name,
            team: team,
            status: status.status,
            pid: status.pid,
            last_exit_code: status.last_exit_code,
            required: Map.get(status, :required, true)
          }
      end
    end)
  end

  defp record_launchd_overlap_event(nil, signature) do
    TeamJay.EventLake.record(%{
      event_type: "phase3_launchd_overlap_changed",
      team: "system",
      bot_name: "diagnostics",
      severity: "warn",
      title: "Phase3 launchd overlap 상태 불명",
      message: "launchd overlap 결과를 찾지 못했습니다",
      tags: ["phase3", "diagnostics", "launchd_overlap"],
      metadata: %{signature: signature}
    })
  end

  defp record_launchd_overlap_event(overlap_result, signature) do
    overlaps = Map.get(overlap_result, :overlaps, [])

    TeamJay.EventLake.record(%{
      event_type: "phase3_launchd_overlap_changed",
      team: "system",
      bot_name: "diagnostics",
      severity: if(overlaps == [], do: "info", else: "warn"),
      title: "Phase3 launchd overlap 변경",
      message: overlap_result.message,
      tags: ["phase3", "diagnostics", "launchd_overlap"],
      metadata: %{signature: signature, overlaps: overlaps, overlap_count: length(overlaps)}
    })
  end

  defp maybe_alarm_shadow_report(report, "warn") do
    failing_agents =
      report.agents
      |> Enum.filter(&(&1.consecutive_failures > 0 or &1.status == :missing))
      |> Enum.map(fn agent ->
        "#{agent.name}(#{agent.status}, fail=#{agent.consecutive_failures})"
      end)
      |> Enum.join(", ")

    overlap_text =
      case report.overlaps do
        [] -> "없음"
        overlaps -> overlaps |> Enum.take(6) |> Enum.join(", ")
      end

    week2_issues =
      report.week2_shadow_agents
      |> Enum.filter(&(&1.status == :missing or is_integer(&1.last_exit_code)))
      |> Enum.map(fn agent ->
        suffix =
          cond do
            is_integer(agent.last_exit_code) -> ", exit=#{agent.last_exit_code}"
            true -> ""
          end

        "#{agent.name}(#{agent.status}#{suffix})"
      end)
      |> Enum.join(", ")

    week3_issues =
      report.week3_shadow_agents
      |> Enum.filter(&(&1.status == :missing or is_integer(&1.last_exit_code)))
      |> Enum.map(fn agent ->
        suffix =
          cond do
            is_integer(agent.last_exit_code) -> ", exit=#{agent.last_exit_code}"
            true -> ""
          end

        "#{agent.name}(#{agent.status}#{suffix})"
      end)
      |> Enum.join(", ")

    message = """
    ⚠️ Phase3 Shadow 리포트
    겹침: #{report.overlap_count}건
    failing: #{report.summary.failing}
    missing: #{report.summary.missing}
    week2 running: #{report.week2_summary.running}
    week2 loaded: #{report.week2_summary.loaded}
    week2 missing: #{report.week2_summary.missing}
    week2 required_missing: #{report.week2_summary.required_missing}
    week3 running: #{report.week3_summary.running}
    week3 loaded: #{report.week3_summary.loaded}
    week3 missing: #{report.week3_summary.missing}
    week3 required_missing: #{report.week3_summary.required_missing}
    overlaps: #{overlap_text}
    agents: #{if(failing_agents == "", do: "없음", else: failing_agents)}
    week2 issues: #{if(week2_issues == "", do: "없음", else: week2_issues)}
    week3 issues: #{if(week3_issues == "", do: "없음", else: week3_issues)}
    """

    _ = TeamJay.HubClient.post_alarm(String.trim(message), "claude", "diagnostics")
  end

  defp maybe_alarm_shadow_report(_report, _severity), do: :ok

  defp schedule_check, do: Process.send_after(self(), :check, @check_interval)
end
