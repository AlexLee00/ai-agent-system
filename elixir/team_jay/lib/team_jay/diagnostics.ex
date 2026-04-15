defmodule TeamJay.Diagnostics do
  @moduledoc """
  BEAM 프로세스 상태 점검 + 이상 알림.
  """
  use GenServer
  require Logger

  @check_interval 30_000
  @msg_queue_warn 100
  @memory_warn 120_000_000
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
    "ai.steward.weekly",
    "ai.investment.commander",
    "ai.investment.crypto",
    "ai.investment.crypto.validation",
    "ai.investment.domestic",
    "ai.investment.domestic.validation",
    "ai.investment.overseas",
    "ai.investment.overseas.validation",
    "ai.investment.argos",
    "ai.investment.reporter",
    "ai.investment.health-check",
    "ai.investment.unrealized-pnl",
    "ai.investment.prescreen-domestic",
    "ai.investment.prescreen-overseas",
    "ai.investment.market-alert-domestic-open",
    "ai.investment.market-alert-domestic-close",
    "ai.investment.market-alert-overseas-open",
    "ai.investment.market-alert-overseas-close",
    "ai.investment.market-alert-crypto-daily"
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
    {:blog_daily, :blog, true},
    {:blog_commenter, :blog, true},
    {:blog_node_server, :blog, true}
  ]
  @week3_shadow_agents [
    {:worker_lead, :worker, true},
    {:worker_task_runner, :worker, true},
    {:worker_web, :worker, true},
    {:worker_nextjs, :worker, true},
    {:worker_health_check, :worker, true},
    {:worker_claude_monitor, :worker, true},
    {:darwin_orchestrator, :platform, false},
    {:hub_resource_api, :platform, true}
  ]

  defstruct [
    :checks,
    :alerts,
    :last_check,
    :last_overlap_signature,
    :last_pilot_signature,
    :last_memory_signature,
    :memory_warn_streak
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    Logger.info("[Diagnostics] BEAM 모니터링 시작!")
    schedule_check()
    {:ok,
     %__MODULE__{
       checks: [],
       alerts: [],
       last_check: nil,
       last_overlap_signature: nil,
       last_pilot_signature: nil,
       last_memory_signature: nil,
       memory_warn_streak: 0
     }}
  end

  @impl true
  def handle_info(:check, state) do
    results = run_diagnostics()
    {alerts, memory_warn_streak} = filter_runtime_alerts(results, state.memory_warn_streak)
    overlap_signature = maybe_record_launchd_overlap(results, state.last_overlap_signature)
    memory_signature =
      maybe_record_memory_pressure(results, state.last_memory_signature, memory_warn_streak)
    report =
      build_shadow_report(%{
        state
        | checks: results,
          alerts: alerts,
          memory_warn_streak: memory_warn_streak
      })
    pilot_signature = maybe_record_next_pilot(report, state.last_pilot_signature)

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
         memory_warn_streak: memory_warn_streak,
         last_check: DateTime.utc_now(),
         last_overlap_signature: overlap_signature,
         last_pilot_signature: pilot_signature,
         last_memory_signature: memory_signature
     }}
  end

  def get_status, do: GenServer.call(__MODULE__, :get_status)
  def shadow_report, do: GenServer.call(__MODULE__, :shadow_report)
  def publish_shadow_report, do: GenServer.call(__MODULE__, :publish_shadow_report)

  @impl true
  def handle_call(:get_status, _from, state), do: {:reply, state, state}

  @impl true
  def handle_call(:shadow_report, _from, state) do
    results = run_diagnostics()
    {alerts, memory_warn_streak} = filter_runtime_alerts(results, state.memory_warn_streak)

    updated_state = %{
      state
      | checks: results,
        alerts: alerts,
        memory_warn_streak: memory_warn_streak,
        last_check: DateTime.utc_now()
    }

    {:reply, build_shadow_report(updated_state), updated_state}
  end

  @impl true
  def handle_call(:publish_shadow_report, _from, state) do
    results = run_diagnostics()
    {alerts, memory_warn_streak} = filter_runtime_alerts(results, state.memory_warn_streak)

    updated_state = %{
      state
      | checks: results,
        alerts: alerts,
        memory_warn_streak: memory_warn_streak,
        last_check: DateTime.utc_now()
    }

    report = build_shadow_report(updated_state)
    total_required_missing =
      report.week2_summary.required_missing + report.week3_summary.required_missing
    total_shadow_loaded = report.week2_summary.loaded + report.week3_summary.loaded
    total_shadow_running = report.week2_summary.running + report.week3_summary.running

    severity =
      cond do
        total_required_missing > 0 ->
          "warn"

        report.summary.missing > 0 ->
          "warn"

        not report.transition_plan.ready_for_pilot ->
          "warn"

        true ->
          "info"
      end

    TeamJay.EventLake.record(%{
      event_type: "phase3_shadow_report",
      team: "system",
      bot_name: "diagnostics",
      severity: severity,
      title: "Phase3 Shadow 리포트",
      message:
        "phase3 loaded #{report.overlap_loaded_count}/#{report.overlap_expected_count} | week1 failing #{report.summary.failing} | week1 missing #{report.summary.missing} | shadow running #{total_shadow_running} | shadow loaded #{total_shadow_loaded} | required missing #{total_required_missing} | next pilot #{format_single_candidate(report.transition_plan.next_pilot_candidate)} | pilot label #{format_runbook_label(report.pilot_runbook)}",
      tags: ["phase3", "diagnostics", "shadow_report"],
      metadata: report
    })

    maybe_alarm_shadow_report(report, severity)

    {:reply, report, updated_state}
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

  defp filter_runtime_alerts(results, previous_memory_warn_streak) do
    memory_alert = Enum.find(results, &(&1.name == "memory_total"))

    memory_warn_streak =
      cond do
        is_nil(memory_alert) -> 0
        memory_alert.severity in [:warn, :error] -> previous_memory_warn_streak + 1
        true -> 0
      end

    alerts =
      results
      |> Enum.filter(&(&1.severity in [:warn, :error]))
      |> Enum.reject(fn alert ->
        alert.name == "memory_total" and memory_warn_streak < 2
      end)
      |> Enum.map(fn alert ->
        if alert.name == "memory_total" do
          Map.put(alert, :message, "#{alert.message} | streak=#{memory_warn_streak}")
        else
          alert
        end
      end)

    {alerts, memory_warn_streak}
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
    processes = mem[:processes] || 0
    binary = mem[:binary] || 0
    ets = mem[:ets] || 0
    atom = mem[:atom] || 0

    %{
      name: "memory_total",
      value: total,
      severity: if(total > @memory_warn, do: :warn, else: :ok),
      processes: processes,
      binary: binary,
      ets: ets,
      atom: atom,
      message:
        "#{format_mb(total)}MB (proc=#{format_mb(processes)}MB, binary=#{format_mb(binary)}MB, ets=#{format_mb(ets)}MB, atom=#{format_mb(atom)}MB)"
    }
  end

  defp format_mb(bytes) when is_integer(bytes) do
    Float.round(bytes / 1_000_000, 1)
  end

  defp check_supervisors do
    supervisors = [
      TeamJay.Teams.SkaSupervisor,
      TeamJay.Teams.ClaudeSupervisor,
      TeamJay.Teams.StewardSupervisor,
      TeamJay.Teams.InvestmentSupervisor,
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
    case get_loaded_launchd_labels() do
      {:ok, loaded} ->
        overlaps =
          @phase3_launchd_labels
          |> Enum.filter(&MapSet.member?(loaded, &1))

        [
          %{
            name: "launchd_phase3_overlap",
            severity: :ok,
            message: "loaded #{length(overlaps)}건",
            overlaps: overlaps,
            loaded_count: length(overlaps),
            expected_labels: length(@phase3_launchd_labels)
          }
        ]

      {:error, message} ->
        [
          %{
            name: "launchd_phase3_overlap",
            severity: :warn,
            message: message
          }
        ]
    end
  end

  defp get_loaded_launchd_labels do
    uid = System.get_env("UID") || System.cmd("id", ["-u"]) |> elem(0) |> String.trim()

    case System.cmd("launchctl", ["print", "gui/#{uid}"]) do
      {output, 0} ->
        loaded =
          output
          |> String.split("\n", trim: true)
          |> Enum.flat_map(&extract_launchd_labels/1)
          |> MapSet.new()

        {:ok, loaded}

      {error, code} ->
        {:error, "launchctl 조회 실패 code=#{code} #{String.slice(error, 0, 120)}"}
    end
  end

  defp extract_launchd_labels(line) do
    trimmed = String.trim(line)

    cond do
      trimmed == "" ->
        []

      Regex.match?(~r/^[-\d]+\s+[-\d]+\s+ai\./, trimmed) ->
        case Regex.run(~r/(ai\.[A-Za-z0-9.\-_]+)/, trimmed, capture: :all_but_first) do
          [label] -> [label]
          _ -> []
        end

      Regex.match?(~r/^"ai\.[^"]+"\s+=>\s+enabled$/, trimmed) ->
        case Regex.run(~r/^"(ai\.[^"]+)"/, trimmed, capture: :all_but_first) do
          [label] -> [label]
          _ -> []
        end

      true ->
        []
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

  defp maybe_record_next_pilot(report, last_signature) do
    signature =
      case report.transition_plan.next_pilot_candidate do
        nil -> "none"
        candidate -> "#{candidate.team}:#{candidate.name}:#{candidate.priority_score}"
      end

    if signature != last_signature do
      record_next_pilot_event(report.transition_plan.next_pilot_candidate, signature, report.transition_plan.blockers)
    end

    signature
  end

  defp maybe_record_memory_pressure(results, last_signature, memory_warn_streak) do
    memory_result = Enum.find(results, &(&1.name == "memory_total"))

    signature =
      case memory_result do
        nil ->
          "missing"

        result ->
          Enum.join([
            Atom.to_string(result.severity),
            Integer.to_string(result.value || 0),
            Integer.to_string(memory_warn_streak)
          ], "|")
      end

    if signature != last_signature do
      record_memory_pressure_event(memory_result, signature, memory_warn_streak)
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

    migration_candidates = %{
      week2: build_transition_candidates(week2_shadow_agents),
      week3: build_transition_candidates(week3_shadow_agents)
    }

    transition_plan =
      build_transition_plan(week2_shadow_agents, week3_shadow_agents, week2_summary, week3_summary)

    pilot_runbook = build_pilot_runbook(transition_plan.next_pilot_candidate)

    recommended_actions =
      build_recommended_actions(summary, week2_summary, week3_summary, migration_candidates, transition_plan)

    %{
      generated_at: DateTime.utc_now(),
      overlap_count: length(Map.get(overlap_result, :overlaps, [])),
      overlap_loaded_count: Map.get(overlap_result, :loaded_count, length(Map.get(overlap_result, :overlaps, []))),
      overlap_expected_count: Map.get(overlap_result, :expected_labels, length(@phase3_launchd_labels)),
      overlaps: Map.get(overlap_result, :overlaps, []),
      supervisor_alerts: Enum.map(state.alerts, &Map.take(&1, [:name, :severity, :message])),
      agents: agent_statuses,
      week2_shadow_agents: week2_shadow_agents,
      week2_summary: week2_summary,
      week3_shadow_agents: week3_shadow_agents,
      week3_summary: week3_summary,
      migration_candidates: migration_candidates,
      top_transition_candidates: %{
        week2: Enum.take(migration_candidates.week2, 3),
        week3: Enum.take(migration_candidates.week3, 3)
      },
      transition_plan: transition_plan,
      pilot_runbook: pilot_runbook,
      recommended_actions: recommended_actions,
      summary: summary,
      recent_failures: TeamJay.EventLake.get_by_type("port_agent_failed", 5)
    }
  end

  defp build_launchd_shadow_agents(agents) do
    Enum.map(agents, fn agent ->
      {name, team, required} = normalize_shadow_agent(agent)

      case GenServer.whereis(TeamJay.Agents.LaunchdShadowAgent.via(name)) do
        nil ->
          %{
            name: name,
            team: team,
            label: nil,
            status: :missing,
            pid: nil,
            last_exit_code: nil,
            required: required
          }

        _pid ->
          status = TeamJay.Agents.LaunchdShadowAgent.get_status(name)

          %{
            name: name,
            team: team,
            label: Map.get(status, :label),
            status: status.status,
            pid: status.pid,
            last_exit_code: status.last_exit_code,
            required: Map.get(status, :required, true)
          }
      end
    end)
  end

  defp normalize_shadow_agent({name, team}), do: {name, team, true}
  defp normalize_shadow_agent({name, team, required}), do: {name, team, required}

  defp build_transition_candidates(agents) do
    agents
    |> Enum.filter(&(&1.status == :loaded and Map.get(&1, :required, true)))
    |> Enum.map(&Map.take(&1, [:name, :team, :status, :label]))
  end

  defp build_recommended_actions(summary, week2_summary, week3_summary, migration_candidates, transition_plan) do
    []
    |> maybe_add_action(summary.failing > 0, "Week1 failing agent 먼저 안정화")
    |> maybe_add_action(week2_summary.required_missing > 0, "Week2 필수 shadow 누락 서비스 점검")
    |> maybe_add_action(week3_summary.required_missing > 0, "Week3 필수 shadow 누락 서비스 점검")
    |> maybe_add_action(length(migration_candidates.week2) > 0, "Week2 loaded 서비스 중 저위험 후보를 병렬 전환 검토")
    |> maybe_add_action(length(migration_candidates.week3) > 0, "Week3 loaded 서비스 중 저위험 후보를 병렬 전환 검토")
    |> maybe_add_action(length(transition_plan.pilot_candidates) > 0, "pilot 후보 1개를 골라 launchd vs Elixir 병렬 비교 시작")
  end

  defp maybe_add_action(actions, true, action), do: actions ++ [action]
  defp maybe_add_action(actions, false, _action), do: actions

  defp build_transition_plan(week2_agents, week3_agents, week2_summary, week3_summary) do
    candidates =
      (week2_agents ++ week3_agents)
      |> Enum.filter(&(&1.status == :loaded and Map.get(&1, :required, true)))

    pilot_candidates =
      candidates
      |> Enum.filter(&pilot_safe?/1)
      |> Enum.map(&score_transition_candidate/1)
      |> Enum.sort_by(&{-&1.priority_score, Atom.to_string(&1.name)})

    top_pilots = Enum.take(pilot_candidates, 3)
    next_pilot_candidate = List.first(top_pilots)

    blockers =
      []
      |> maybe_add_blocker(week2_summary.required_missing > 0, "Week2 required shadow missing 존재")
      |> maybe_add_blocker(week3_summary.required_missing > 0, "Week3 required shadow missing 존재")
      |> maybe_add_blocker(Enum.empty?(top_pilots), "즉시 파일럿 가능한 loaded 후보가 부족함")

    %{
      pilot_candidates: top_pilots,
      next_pilot_candidate: next_pilot_candidate,
      blockers: blockers,
      ready_for_pilot: blockers == []
    }
  end

  defp pilot_safe?(%{team: :investment}), do: false
  defp pilot_safe?(%{name: :worker_web}), do: false
  defp pilot_safe?(%{name: :worker_nextjs}), do: false
  defp pilot_safe?(_agent), do: true

  defp score_transition_candidate(agent) do
    team_bonus =
      case agent.team do
        :blog -> 30
        :worker -> 20
        :platform -> 10
        _ -> 0
      end

    name_bonus =
      case agent.name do
        :blog_commenter -> 15
        :blog_daily -> 10
        :worker_task_runner -> 10
        :worker_health_check -> 8
        :worker_claude_monitor -> 6
        _ -> 0
      end

    Map.merge(Map.take(agent, [:name, :team, :status, :label]), %{
      priority_score: 100 + team_bonus + name_bonus
    })
  end

  defp build_pilot_runbook(nil) do
    %{
      ready: false,
      label: nil,
      steps: [],
      note: "현재 즉시 파일럿 가능한 후보가 없습니다"
    }
  end

  defp build_pilot_runbook(candidate) do
    %{
      ready: true,
      label: candidate.label,
      steps: [
        "launchd 서비스 #{candidate.label}의 최근 로그와 health 상태를 먼저 확인",
        "Elixir shadow report에서 #{candidate.name}가 loaded 상태로 2회 이상 안정적으로 유지되는지 확인",
        "짧은 창에서 launchd와 Elixir를 병렬 비교하고 결과를 event_lake에 기록",
        "불일치 0건이면 다음 창에서 launchd off -> Elixir on 파일럿 전환 검토"
      ],
      note: "#{candidate.name}(#{candidate.team})를 다음 파일럿 후보로 권장"
    }
  end

  defp maybe_add_blocker(blockers, true, blocker), do: blockers ++ [blocker]
  defp maybe_add_blocker(blockers, false, _blocker), do: blockers

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
    loaded_count = Map.get(overlap_result, :loaded_count, length(overlaps))
    expected_labels = Map.get(overlap_result, :expected_labels, length(@phase3_launchd_labels))

    TeamJay.EventLake.record(%{
      event_type: "phase3_launchd_overlap_changed",
      team: "system",
      bot_name: "diagnostics",
      severity: "info",
      title: "Phase3 launchd overlap 변경",
      message: overlap_result.message,
      tags: ["phase3", "diagnostics", "launchd_overlap"],
      metadata: %{
        signature: signature,
        overlaps: overlaps,
        overlap_count: length(overlaps),
        loaded_count: loaded_count,
        expected_labels: expected_labels
      }
    })
  end

  defp record_next_pilot_event(nil, signature, blockers) do
    TeamJay.EventLake.record(%{
      event_type: "phase3_next_pilot_changed",
      team: "system",
      bot_name: "diagnostics",
      severity: "info",
      title: "Phase3 다음 파일럿 후보 없음",
      message: "현재 즉시 파일럿 가능한 후보가 없습니다",
      tags: ["phase3", "diagnostics", "pilot_candidate"],
      metadata: %{signature: signature, blockers: blockers}
    })
  end

  defp record_next_pilot_event(candidate, signature, blockers) do
    TeamJay.EventLake.record(%{
      event_type: "phase3_next_pilot_changed",
      team: "system",
      bot_name: "diagnostics",
      severity: "info",
      title: "Phase3 다음 파일럿 후보 변경",
      message: "#{candidate.name}(#{candidate.team}) score=#{candidate.priority_score}",
      tags: ["phase3", "diagnostics", "pilot_candidate"],
      metadata: %{signature: signature, candidate: candidate, blockers: blockers}
    })
  end

  defp record_memory_pressure_event(nil, signature, memory_warn_streak) do
    TeamJay.EventLake.record(%{
      event_type: "beam_memory_pressure_changed",
      team: "system",
      bot_name: "diagnostics",
      severity: "warn",
      title: "BEAM 메모리 상태 불명",
      message: "memory_total 결과를 찾지 못했습니다",
      tags: ["phase3", "diagnostics", "beam_memory"],
      metadata: %{signature: signature, streak: memory_warn_streak}
    })
  end

  defp record_memory_pressure_event(memory_result, signature, memory_warn_streak) do
    severity =
      case memory_result.severity do
        :warn -> "warn"
        :error -> "error"
        _ -> "info"
      end

    TeamJay.EventLake.record(%{
      event_type: "beam_memory_pressure_changed",
      team: "system",
      bot_name: "diagnostics",
      severity: severity,
      title: "BEAM 메모리 상태 변경",
      message: memory_result.message,
      tags: ["phase3", "diagnostics", "beam_memory"],
      metadata: %{
        signature: signature,
        streak: memory_warn_streak,
        severity: memory_result.severity,
        total: memory_result.value,
        processes: Map.get(memory_result, :processes),
        binary: Map.get(memory_result, :binary),
        ets: Map.get(memory_result, :ets),
        atom: Map.get(memory_result, :atom)
      }
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
    phase3 loaded: #{report.overlap_loaded_count}/#{report.overlap_expected_count}
    failing: #{report.summary.failing}
    week1 missing: #{report.summary.missing}
    week2 running: #{report.week2_summary.running}
    week2 loaded: #{report.week2_summary.loaded}
    week2 missing: #{report.week2_summary.missing}
    week2 required_missing: #{report.week2_summary.required_missing}
    week3 running: #{report.week3_summary.running}
    week3 loaded: #{report.week3_summary.loaded}
    week3 missing: #{report.week3_summary.missing}
    week3 required_missing: #{report.week3_summary.required_missing}
    week2 candidates: #{length(report.migration_candidates.week2)}
    week3 candidates: #{length(report.migration_candidates.week3)}
    week2 top: #{format_candidate_names(report.top_transition_candidates.week2)}
    week3 top: #{format_candidate_names(report.top_transition_candidates.week3)}
    pilot: #{format_candidate_names(report.transition_plan.pilot_candidates)}
    next pilot: #{format_single_candidate(report.transition_plan.next_pilot_candidate)}
    pilot label: #{format_runbook_label(report.pilot_runbook)}
    pilot ready: #{if(report.pilot_runbook.ready, do: "yes", else: "no")}
    pilot note: #{report.pilot_runbook.note}
    pilot step1: #{format_runbook_step(report.pilot_runbook, 0)}
    pilot step2: #{format_runbook_step(report.pilot_runbook, 1)}
    blockers: #{format_text_list(report.transition_plan.blockers)}
    overlaps: #{overlap_text}
    agents: #{if(failing_agents == "", do: "없음", else: failing_agents)}
    week2 issues: #{if(week2_issues == "", do: "없음", else: week2_issues)}
    week3 issues: #{if(week3_issues == "", do: "없음", else: week3_issues)}
    next: #{Enum.join(report.recommended_actions, " | ")}
    """

    _ = TeamJay.HubClient.post_alarm(String.trim(message), "claude", "diagnostics")
  end

  defp maybe_alarm_shadow_report(_report, _severity), do: :ok

  defp format_candidate_names([]), do: "없음"

  defp format_candidate_names(candidates) do
    candidates
    |> Enum.map(&to_string(&1.name))
    |> Enum.join(", ")
  end

  defp format_single_candidate(nil), do: "없음"

  defp format_single_candidate(candidate) do
    "#{candidate.name}(#{candidate.team}, score=#{candidate.priority_score})"
  end

  defp format_runbook_label(%{label: nil}), do: "없음"
  defp format_runbook_label(%{label: label}), do: label

  defp format_runbook_step(%{steps: steps}, index) do
    case Enum.at(steps, index) do
      nil -> "없음"
      step -> step
    end
  end

  defp format_text_list([]), do: "없음"
  defp format_text_list(items), do: Enum.join(items, " | ")

  defp schedule_check, do: Process.send_after(self(), :check, @check_interval)
end
