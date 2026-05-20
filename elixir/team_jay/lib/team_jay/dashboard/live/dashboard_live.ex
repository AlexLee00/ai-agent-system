defmodule TeamJay.Dashboard.Live.DashboardLive do
  use Phoenix.LiveView, layout: {TeamJay.Dashboard.Layouts, :app}
  require Logger

  @pubsub TeamJay.PubSub

  @kst_offset_seconds 9 * 60 * 60
  @phase_labels %{1 => {"🔴", "감시"}, 2 => {"🟡", "반자율"}, 3 => {"🟢", "자율"}}
  @phase_thresholds %{1 => 7, 2 => 30}
  @cycle_steps ~w(SENSE ANALYZE DECIDE ACT MEASURE LEARN)
  @mapek_phases ~w(M A P E K)

  # Phase C: 영역 5 파이프라인 메타
  @pipelines_meta [
    {:ska_to_blog, "스카→블로", "📢"},
    {:luna_to_blog, "루나→블로", "📊"},
    {:blog_to_ska, "블로→스카", "🔑"},
    {:ska_to_luna, "스카→루나", "💰"},
    {:claude_to_all, "클로드→전체", "🚨"},
    {:blog_to_luna, "블로→루나", "🔍"},
    {:luna_to_ska, "루나→스카", "💸"}
  ]

  # Phase C: 영역 6 팀 메타
  @teams_meta [
    %{key: "ska", label: "스카", emoji: "🏫"},
    %{key: "luna", label: "루나", emoji: "🌙"},
    %{key: "blog", label: "블로", emoji: "✍️"},
    %{key: "claude", label: "클로드", emoji: "🖥️"},
    %{key: "jay", label: "제이", emoji: "🤖"},
    %{key: "sigma", label: "시그마", emoji: "∑"},
    %{key: "darwin", label: "다윈", emoji: "🧬"},
    %{key: "hub", label: "허브", emoji: "🔌"},
    %{key: "reservation", label: "예약", emoji: "📋"},
    %{key: "social-media", label: "소셜", emoji: "📣"},
    %{key: "master", label: "마스터", emoji: "🧑"},
    %{key: "metty", label: "메티", emoji: "🧠"},
    %{key: "codex", label: "코덱스", emoji: "⌨"}
  ]

  @pipeline_atom_map %{
    "ska_to_blog" => :ska_to_blog,
    "luna_to_blog" => :luna_to_blog,
    "blog_to_ska" => :blog_to_ska,
    "ska_to_luna" => :ska_to_luna,
    "claude_to_all" => :claude_to_all,
    "blog_to_luna" => :blog_to_luna,
    "luna_to_ska" => :luna_to_ska
  }

  # Phase D: 영역 7 Sigma MAPE-K + Pods 메타
  @pods_meta [
    {"🦉", "Trend", :trend_alive, ["owl", "forecaster"]},
    {"🕊️", "Growth", :growth_alive, ["dove", "librarian"]},
    {"🦅", "Risk", :risk_alive, ["hawk", "optimizer"]}
  ]

  # Phase D: 영역 8 Luna 6단계 파이프라인 메타
  @luna_stages_meta [
    {"📡", "market", :market_data},
    {"📊", "analyst", :analyst},
    {"💡", "decision", :decision},
    {"🛡️", "policy", :policy},
    {"⚡", "exec", :execution},
    {"📝", "review", :review}
  ]

  @luna_topic_prefixes [
    :"luna.tv.bar",
    :"luna.binance.trade",
    :"luna.binance.kline",
    :"luna.binance.orderbook",
    :"luna.kis.tick",
    :"luna.kis.quote",
    :"luna.analyst.result",
    :"luna.decision.candidate",
    :"luna.policy.verdict",
    :"luna.execution.order",
    :"luna.execution.fill",
    :"luna.review.trade",
    :"luna.circuit.breaker"
  ]

  # Phase G: v3.3 영역 10/11 Project + Milestone visibility topics
  @project_topics [
    "project.task.created",
    "project.task.stage_changed",
    "project.milestone.added",
    "project.milestone.achieved",
    "project.milestone.missed"
  ]

  # ── Mount ────────────────────────────────────────────────────────

  @impl true
  def mount(_params, _session, socket) do
    if connected?(socket) do
      Phoenix.PubSub.subscribe(@pubsub, "event_lake:new")
      Phoenix.PubSub.subscribe(@pubsub, "autonomy:phase_changed")
      Phoenix.PubSub.subscribe(@pubsub, "autonomy_phase_change")
      Phoenix.PubSub.subscribe(@pubsub, "project:visibility")
      # GrowthCycle 토픽은 JayBus(Registry) 직접 구독
      safe_subscribe(:growth_cycle_started)
      safe_subscribe(:growth_cycle_completed)
      safe_subscribe(:team_data_collected)
      safe_subscribe(:briefing_ready)
      # Phase C: 7개 크로스팀 파이프라인 토픽 구독
      for topic <- safe_cross_topics() do
        safe_subscribe(topic)
      end

      # Phase D: Sigma/Luna 보드. Luna 토픽은 Jay.Core.JayBus에 직접 구독한다.
      for topic <- safe_luna_topics() do
        safe_jay_bus_subscribe(topic)
      end

      for topic <- safe_project_topics() do
        safe_jay_bus_subscribe(topic)
      end

      # Phase C/D: Andy/Jimmy + Sigma/Luna 30초 주기 갱신
      Process.send_after(self(), :refresh_agents, 30_000)
      Process.send_after(self(), :refresh_sigma_luna, 30_000)
      Process.send_after(self(), :refresh_project_visibility, 60_000)
    end

    {:ok, assign_initial_state(socket)}
  end

  # ── PubSub/JayBus 핸들러 ─────────────────────────────────────────

  @impl true
  def handle_info({:event_lake_new, event}, socket) do
    events = [event | Enum.take(socket.assigns.events, 49)]
    stats = safe_call(fn -> Jay.Core.EventLake.get_stats() end, socket.assigns.event_stats)
    cycles = safe_call(fn -> load_recent_cycles() end, socket.assigns.cycles)
    team_health = update_team_last_active(socket.assigns.team_health, event)
    cross_pipelines = update_pipeline_from_event(socket.assigns.cross_pipelines, event)

    {:noreply,
     assign(socket,
       events: events,
       event_stats: stats,
       cycles: cycles,
       team_health: team_health,
       cross_pipelines: cross_pipelines
     )}
  end

  def handle_info({:phase_changed, _}, socket) do
    {:noreply, refresh_phase_status(socket)}
  end

  def handle_info({:autonomy_phase_change, _from, _to}, socket) do
    {:noreply, refresh_phase_status(socket)}
  end

  def handle_info({:jay_bus, :growth_cycle_started, payload}, socket) do
    {:noreply,
     assign(socket,
       cycle_status: :running,
       cycle_start_payload: payload,
       teams_collected: []
     )}
  end

  def handle_info({:jay_bus, :team_data_collected, payload}, socket) do
    teams = [to_string(payload[:team] || payload["team"]) | socket.assigns.teams_collected]
    {:noreply, assign(socket, teams_collected: Enum.uniq(teams))}
  end

  def handle_info({:jay_bus, :growth_cycle_completed, _payload}, socket) do
    growth_cycle = safe_call(fn -> Jay.V2.GrowthCycle.status() end, socket.assigns.growth_cycle)

    {:noreply,
     assign(socket, cycle_status: :completed, growth_cycle: growth_cycle, teams_collected: [])}
  end

  def handle_info({:jay_bus, :briefing_ready, _payload}, socket) do
    growth_cycle = safe_call(fn -> Jay.V2.GrowthCycle.status() end, socket.assigns.growth_cycle)
    {:noreply, assign(socket, cycle_status: :completed, growth_cycle: growth_cycle)}
  end

  # Phase C: 7개 크로스팀 파이프라인 실시간 카운트 갱신
  def handle_info({:jay_bus, topic, _payload}, socket)
      when topic in [
             :ska_to_blog,
             :luna_to_blog,
             :blog_to_ska,
             :ska_to_luna,
             :claude_to_all,
             :blog_to_luna,
             :luna_to_ska
           ] do
    cross_pipelines = update_pipeline_count(socket.assigns.cross_pipelines, topic)
    {:noreply, assign(socket, cross_pipelines: cross_pipelines)}
  end

  # Phase D/G: Luna 13개 토픽 및 Project 토픽 실시간 갱신
  def handle_info({:jay_bus, topic, payload}, socket) do
    topic_text = topic_to_string(topic)

    cond do
      project_topic?(topic_text) ->
        {:noreply, refresh_project_visibility(socket)}

      luna_topic?(topic_text) ->
        stage = topic_to_stage(topic_text)

        luna_pipeline =
          update_luna_pipeline(socket.assigns.luna_pipeline, stage, topic_text, payload)

        {:noreply, assign(socket, luna_pipeline: luna_pipeline)}

      true ->
        {:noreply, socket}
    end
  end

  # Phase C: Andy/Jimmy 주기적 갱신
  def handle_info(:refresh_agents, socket) do
    team_health = safe_call(fn -> load_team_health() end, socket.assigns.team_health)
    growth_cycle = safe_call(fn -> load_growth_cycle_status() end, socket.assigns.growth_cycle)

    growth_scheduler =
      safe_call(fn -> load_growth_scheduler_status() end, socket.assigns.growth_scheduler)

    Process.send_after(self(), :refresh_agents, 30_000)

    {:noreply,
     assign(socket,
       team_health: team_health,
       growth_cycle: growth_cycle,
       growth_scheduler: growth_scheduler
     )}
  end

  # Phase D: Sigma MAPE-K/Pod 상태와 Luna EventLake seed 주기 갱신
  def handle_info(:refresh_sigma_luna, socket) do
    sigma_status = safe_call(fn -> load_sigma_status() end, socket.assigns.sigma_status)

    seeded_luna_pipeline =
      merge_luna_pipeline_seed(socket.assigns.luna_pipeline, load_luna_pipeline_seed())

    Process.send_after(self(), :refresh_sigma_luna, 30_000)
    {:noreply, assign(socket, sigma_status: sigma_status, luna_pipeline: seeded_luna_pipeline)}
  end

  # Phase G: project schema/config visibility refresh
  def handle_info(:refresh_project_visibility, socket) do
    Process.send_after(self(), :refresh_project_visibility, 60_000)
    {:noreply, refresh_project_visibility(socket)}
  end

  def handle_info({:project_event, _topic, _payload}, socket) do
    {:noreply, refresh_project_visibility(socket)}
  end

  # Phase F: Langfuse API 비동기 조회 시작 (UI 블로킹 방지)
  def handle_info({:fetch_trace, trace_id}, socket) do
    parent = self()

    Task.start(fn ->
      result = TeamJay.Dashboard.LangfuseClient.get_trace(trace_id)
      send(parent, {:langfuse_trace_loaded, trace_id, result})
    end)

    {:noreply, socket}
  end

  # Phase F: Langfuse API 결과 수신 (race condition 방어)
  def handle_info({:langfuse_trace_loaded, trace_id, result}, socket) do
    if socket.assigns.selected_trace_id == trace_id do
      socket =
        case result do
          {:ok, trace} ->
            assign(socket, trace_detail: trace, trace_loading: false)

          {:error, :not_found} ->
            assign(socket, trace_detail: :not_found, trace_loading: false)

          {:error, reason} ->
            Logger.warning("[DashboardLive] Langfuse API 오류: #{inspect(reason)}")
            assign(socket, trace_detail: :error, trace_loading: false)
        end

      {:noreply, socket}
    else
      {:noreply, socket}
    end
  end

  def handle_info(_msg, socket), do: {:noreply, socket}

  # ── Events ───────────────────────────────────────────────────────

  # Phase F: 영역 9 — trace_id 클릭 시 비동기 API 조회
  @impl true
  def handle_event("show_trace", %{"id" => trace_id}, socket) do
    socket =
      assign(socket,
        selected_trace_id: trace_id,
        trace_loading: true,
        trace_detail: nil
      )

    send(self(), {:fetch_trace, trace_id})
    {:noreply, socket}
  end

  def handle_event("close_trace", _params, socket) do
    {:noreply, assign(socket, selected_trace_id: nil, trace_detail: nil, trace_loading: false)}
  end

  # Phase G: 영역 10 task 상세/수동 stage 변경. 클릭 전에는 DB write 없음.
  def handle_event("task_view", %{"id" => task_id}, socket) do
    task = find_project_task(socket.assigns.tasks_by_stage, task_id)
    {:noreply, assign(socket, selected_project_task: task, project_error: nil)}
  end

  def handle_event("close_task", _params, socket) do
    {:noreply, assign(socket, selected_project_task: nil, project_error: nil)}
  end

  def handle_event("task_stage_change", %{"id" => task_id, "stage" => stage}, socket) do
    socket =
      case TeamJay.Dashboard.ProjectVisibility.update_task_stage(task_id, stage) do
        {:ok, task} ->
          socket
          |> refresh_project_visibility()
          |> assign(:selected_project_task, task)
          |> assign(:project_error, nil)

        {:error, reason} ->
          assign(socket, :project_error, "task stage 변경 실패: #{inspect(reason)}")
      end

    {:noreply, socket}
  end

  # ── Render ───────────────────────────────────────────────────────

  @impl true
  def render(assigns) do
    ~H"""
    <div class="min-h-screen p-4 space-y-4">
      <header class="flex items-center justify-between border-b border-gray-700 pb-3">
        <h1 class="text-xl font-bold text-white">🤖 팀 제이 대시보드</h1>
        <span class="text-xs text-gray-400">Phase G • 영역 1~11 + Layer 1 + Project schema</span>
      </header>

      <div class="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div class="xl:col-span-2 space-y-4">
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <!-- 영역 1: 자율화 Phase 보드 -->
            <.phase_board phase_status={@phase_status} />

            <!-- 영역 3: 오늘의 GrowthCycle -->
            <.growth_cycle_board
              growth_cycle={@growth_cycle}
              cycle_status={@cycle_status}
              teams_collected={@teams_collected}
              growth_scheduler={@growth_scheduler}
            />
          </div>

          <!-- 영역 4: EventLake 실시간 스트림 -->
          <.event_lake_board events={@events} event_stats={@event_stats} />

          <!-- 영역 9: Langfuse Trace 상세 (항상 표시, 4상태 분기) -->
          <.trace_detail_board
            trace_id={@selected_trace_id}
            trace_detail={@trace_detail}
            trace_loading={@trace_loading}
          />

          <!-- 영역 5+6: 크로스팀 파이프라인 + 팀 헬스 -->
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <.cross_team_board cross_pipelines={@cross_pipelines} />
            <.team_health_board team_health={@team_health} />
          </div>

          <!-- 영역 7+8: Sigma 메타 + Luna 매매 흐름 -->
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <.sigma_board sigma_status={@sigma_status} />
            <.luna_flow_board luna_pipeline={@luna_pipeline} />
          </div>

          <!-- 영역 10: Project + Milestone 보드 -->
          <.project_milestone_board
            projects={@projects}
            metrics={@project_metrics}
            tasks_by_stage={@tasks_by_stage}
            milestones={@milestones}
            kanban_stages={@kanban_stages}
            selected_task={@selected_project_task}
            schema_ready={@project_schema_ready?}
            config_path={@projects_config_path}
            project_error={@project_error}
          />

          <!-- 영역 11: TimelineGantt 2주 -->
          <.timeline_gantt_board gantt={@gantt_data} />
        </div>

        <!-- 영역 2: 협업 타임라인 -->
        <.collab_timeline_board cycles={@cycles} active_sessions={@active_sessions} />
      </div>
    </div>
    """
  end

  # ── 영역 1: Phase 보드 ────────────────────────────────────────────

  attr(:phase_status, :map, required: true)

  defp phase_board(assigns) do
    ~H"""
    <div class="bg-gray-800 rounded-xl p-5 space-y-4">
      <div class="flex items-center gap-2 border-b border-gray-700 pb-2">
        <span class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          [1] 자율화 Phase 보드
        </span>
      </div>

      <.phase_header status={@phase_status} />
      <.phase_progress status={@phase_status} />
      <.phase_meta status={@phase_status} />

      <div class="border-t border-gray-700/50 pt-2 text-[10px] text-gray-500 leading-relaxed">
        <div>전이 조건 · Phase 1 → 2: 7일 연속 무사고 / Phase 2 → 3: 30일 연속 무사고</div>
        <div class="text-gray-600">Trigger: GrowthCycle 일일 완료 · AutonomyGovernor skill · 마스터 수동 개입</div>
      </div>
    </div>
    """
  end

  attr(:status, :map, required: true)

  defp phase_header(assigns) do
    phase = assigns.status[:phase] || 1
    {emoji, label} = Map.get(@phase_labels, phase, {"⚪", "알 수 없음"})
    days_since = days_since_phase_start(assigns.status[:phase_since])
    assigns = assign(assigns, phase: phase, emoji: emoji, label: label, days_since: days_since)

    ~H"""
    <div class="flex items-center gap-4">
      <span class="text-6xl font-black text-white">{@phase}</span>
      <div>
        <div class="text-2xl">{@emoji} {@label}</div>
        <div class="text-xs text-gray-400 mt-1">
          Phase Since: {format_date(@status[:phase_since])} · {@days_since}일째
        </div>
      </div>
    </div>
    """
  end

  attr(:status, :map, required: true)

  defp phase_progress(assigns) do
    phase = assigns.status[:phase] || 1
    days = assigns.status[:consecutive_clean_days] || 0
    threshold = Map.get(@phase_thresholds, phase, 30)
    pct = if phase == 3, do: 100, else: min(round(days / threshold * 100), 100)
    next_phase = phase + 1

    assigns =
      assign(assigns,
        days: days,
        threshold: threshold,
        pct: pct,
        next_phase: next_phase,
        phase: phase
      )

    ~H"""
    <div class="space-y-1">
      <div class="flex justify-between text-xs text-gray-400">
        <span>
          {if @phase == 3, do: "완전 자율 달성", else: "Phase #{@next_phase}까지: #{@days}/#{@threshold}일"}
        </span>
        <span>{@pct}%</span>
      </div>
      <div class="h-2 bg-gray-700 rounded-full overflow-hidden">
        <div
          class={"h-full rounded-full transition-all #{progress_color(@phase)}"}
          style={"width: #{@pct}%"}
        />
      </div>
    </div>
    """
  end

  attr(:status, :map, required: true)

  defp phase_meta(assigns) do
    ~H"""
    <div class="grid grid-cols-2 gap-3 text-sm">
      <div class="bg-gray-700 rounded-lg p-3">
        <div class="text-xs text-gray-400">마스터 개입 횟수</div>
        <div class="text-xl font-bold text-white mt-1">
          {@status[:master_intervention_count] || 0}
          <span class="text-xs font-normal text-gray-400">회</span>
        </div>
      </div>
      <div class="bg-gray-700 rounded-lg p-3">
        <div class="text-xs text-gray-400">마지막 에스컬레이션</div>
        <div class="text-sm font-medium text-white mt-1">
          {format_datetime(@status[:last_escalation_at])}
        </div>
      </div>
    </div>
    """
  end

  # ── 영역 3: GrowthCycle 보드 ─────────────────────────────────────

  attr(:growth_cycle, :map, required: true)
  attr(:cycle_status, :atom, required: true)
  attr(:teams_collected, :list, required: true)
  attr(:growth_scheduler, :map, required: true)

  defp growth_cycle_board(assigns) do
    last_result = assigns.growth_cycle[:last_result]
    last_error = assigns.growth_cycle[:last_error]
    assigns = assign(assigns, last_result: last_result, last_error: last_error)

    ~H"""
    <div class="bg-gray-800 rounded-xl p-5 space-y-4">
      <div class="flex items-center justify-between border-b border-gray-700 pb-2">
        <span class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          [3] 오늘의 GrowthCycle
        </span>
        <span class={"text-xs font-semibold px-2 py-0.5 rounded #{cycle_status_badge(@cycle_status)}"}>
          {cycle_status_label(@cycle_status)}
        </span>
      </div>

      <!-- 6단계 진행 박스 -->
      <div class="flex flex-wrap gap-1.5">
        <%= for step <- @teams_collected |> length() |> steps_completed(@cycle_status) do %>
          <span class={"step-box #{step_color(step.active)}"}>
            {step.name}
            {if step.active, do: " ▶", else: ""}
          </span>
        <% end %>
      </div>

      <!-- 팀 수집 현황 (실행 중) -->
      <%= if @cycle_status == :running and @teams_collected != [] do %>
        <div class="text-xs text-gray-400">
          수집 완료: <span class="text-green-400">{Enum.join(@teams_collected, " · ")}</span>
        </div>
      <% end %>

      <!-- 마지막 결과 -->
      <div class="space-y-1">
        <%= if @last_result do %>
          <div class="text-xs text-gray-400">마지막 사이클</div>
          <div class="text-sm text-white">
            📅 {@last_result[:date] || @last_result["date"]}
            &nbsp;·&nbsp;
            🏢 {@last_result[:teams_collected] || @last_result["teams_collected"] || 0}팀 수집
            &nbsp;·&nbsp;
            📝 {@last_result[:briefing_len] || @last_result["briefing_len"] || 0}자 브리핑
          </div>
        <% else %>
          <div class="text-xs text-gray-500">아직 사이클 기록 없음</div>
        <% end %>

        <%= if @last_error do %>
          <div class="text-xs text-red-400">⚠️ 마지막 오류: {inspect(@last_error)}</div>
        <% end %>
      </div>

      <!-- 다음 실행 -->
      <div class="flex items-center gap-2 text-xs text-gray-400 border-t border-gray-700 pt-3">
        <span>⏰ 다음 실행:</span>
        <span class="text-yellow-400 font-medium">{next_cycle_label(@growth_scheduler)}</span>
      </div>
      <div class="flex items-center gap-2 text-xs text-gray-400">
        <span>launchd:</span>
        <span class={growth_scheduler_class(@growth_scheduler)}>
          ai.jay.growth {growth_scheduler_label(@growth_scheduler)}
        </span>
      </div>
      <%= if warning = growth_scheduler_warning(@growth_scheduler) do %>
        <div class="text-[10px] text-orange-300">
          ⚠️ {warning}
        </div>
      <% end %>
    </div>
    """
  end

  defp default_growth_scheduler do
    %{
      label: "ai.jay.growth",
      loaded?: false,
      pid: nil,
      exit_status: nil,
      state: :unknown,
      schedule: nil
    }
  end

  defp load_growth_cycle_status do
    Jay.V2.GrowthCycle.status()
    |> merge_growth_cycle_seed(load_growth_cycle_seed())
  rescue
    _ -> merge_growth_cycle_seed(%{}, load_growth_cycle_seed())
  end

  defp load_growth_cycle_seed do
    sql = """
    SELECT event_type, metadata, created_at
    FROM agent.event_lake
    WHERE event_type LIKE 'growth_cycle.%'
       OR event_type IN ('growth_cycle_started', 'growth_cycle_completed')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[event_type, metadata, created_at] | _]}} ->
        payload = metadata || %{}

        %{
          last_result: %{
            date: get_in(payload, ["payload", "date"]) || payload["date"],
            teams_collected:
              get_in(payload, ["payload", "teams"])
              |> normalize_collection_count(payload["teams_collected"]),
            briefing_len: payload["briefing_len"],
            source: event_type,
            created_at: created_at
          }
        }

      _ ->
        %{}
    end
  rescue
    _ -> %{}
  end

  defp merge_growth_cycle_seed(current, seed) when is_map(current) and is_map(seed) do
    if current[:last_result] || current["last_result"] || current[:last_error] ||
         current["last_error"] do
      current
    else
      Map.merge(current, seed)
    end
  end

  defp normalize_collection_count(value, fallback)
  defp normalize_collection_count(value, _fallback) when is_list(value), do: length(value)
  defp normalize_collection_count(value, _fallback) when is_integer(value), do: value
  defp normalize_collection_count(_value, fallback) when is_integer(fallback), do: fallback
  defp normalize_collection_count(_value, _fallback), do: 0

  defp load_growth_scheduler_status do
    schedule = load_growth_scheduler_schedule()

    case System.cmd("launchctl", ["list", "ai.jay.growth"], stderr_to_stdout: true) do
      {output, 0} ->
        %{
          label: "ai.jay.growth",
          loaded?: true,
          pid: launchctl_integer(output, "PID"),
          exit_status: launchctl_integer(output, "LastExitStatus"),
          state: :loaded,
          schedule: schedule
        }

      {output, _status} ->
        %{
          label: "ai.jay.growth",
          loaded?: false,
          pid: nil,
          exit_status: nil,
          state:
            if(String.contains?(output, "Could not find service"), do: :not_loaded, else: :error),
          schedule: schedule
        }
    end
  rescue
    _ -> default_growth_scheduler()
  end

  defp load_growth_scheduler_schedule do
    path = Path.expand("~/Library/LaunchAgents/ai.jay.growth.plist")

    case System.cmd("plutil", ["-extract", "StartCalendarInterval", "json", "-o", "-", path],
           stderr_to_stdout: true
         ) do
      {output, 0} ->
        with {:ok, %{"Hour" => hour, "Minute" => minute}} <- Jason.decode(output),
             true <- is_integer(hour),
             true <- is_integer(minute) do
          %{hour: hour, minute: minute, source: path}
        else
          _ -> nil
        end

      _ ->
        nil
    end
  rescue
    _ -> nil
  end

  defp launchctl_integer(output, key) when is_binary(output) do
    case Regex.run(~r/"#{Regex.escape(key)}" = (-?\d+);/, output) do
      [_, value] -> String.to_integer(value)
      _ -> nil
    end
  end

  defp growth_scheduler_label(%{loaded?: true, pid: pid}) when is_integer(pid) and pid > 0,
    do: "loaded · pid #{pid}"

  defp growth_scheduler_label(%{loaded?: true, exit_status: status}) when is_integer(status),
    do: "loaded · idle · last exit #{status}"

  defp growth_scheduler_label(%{loaded?: true}), do: "loaded"
  defp growth_scheduler_label(%{state: :error}), do: "status error"
  defp growth_scheduler_label(_), do: "not loaded"

  defp growth_scheduler_class(%{loaded?: true}),
    do: "text-green-400 font-medium"

  defp growth_scheduler_class(%{state: :error}),
    do: "text-red-400 font-medium"

  defp growth_scheduler_class(_),
    do: "text-orange-400 font-medium"

  defp growth_scheduler_warning(%{schedule: %{hour: 6, minute: 30}}), do: nil

  defp growth_scheduler_warning(%{schedule: %{hour: hour, minute: minute}})
       when is_integer(hour) and is_integer(minute) do
    "문서 기준 06:30 KST와 launchd 설정 #{pad2(hour)}:#{pad2(minute)} KST가 다릅니다."
  end

  defp growth_scheduler_warning(_), do: "launchd StartCalendarInterval을 읽지 못했습니다."

  # ── 영역 4: EventLake 보드 ───────────────────────────────────────

  attr(:events, :list, required: true)
  attr(:event_stats, :map, required: true)

  defp event_lake_board(assigns) do
    top_types = assigns.event_stats |> Map.get(:by_type, %{}) |> top_n(5)
    top_teams = assigns.event_stats |> Map.get(:by_team, %{}) |> top_n(5)
    assigns = assign(assigns, top_types: top_types, top_teams: top_teams)

    ~H"""
    <div class="bg-gray-800 rounded-xl p-5 space-y-4">
      <div class="flex items-center justify-between border-b border-gray-700 pb-2">
        <span class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          [4] EventLake 실시간 스트림
        </span>
        <span class="text-xs text-gray-400">총 {@event_stats[:total] || 0}건</span>
      </div>

      <!-- 통계 카드 -->
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-gray-700 rounded-lg p-3">
          <div class="text-xs text-gray-400 mb-2">이벤트 타입 TOP 5</div>
          <div class="space-y-1">
            <%= for {type, cnt} <- @top_types do %>
              <div class="flex justify-between text-xs">
                <span class="text-gray-300 truncate max-w-[140px]">{type}</span>
                <span class="text-blue-400 ml-2">{cnt}</span>
              </div>
            <% end %>
          </div>
        </div>
        <div class="bg-gray-700 rounded-lg p-3">
          <div class="text-xs text-gray-400 mb-2">팀별 TOP 5</div>
          <div class="space-y-1">
            <%= for {team, cnt} <- @top_teams do %>
              <div class="flex justify-between text-xs">
                <span class="text-gray-300">{team}</span>
                <span class="text-purple-400 ml-2">{cnt}</span>
              </div>
            <% end %>
          </div>
        </div>
      </div>

      <!-- 이벤트 테이블 -->
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="text-gray-400 border-b border-gray-700">
              <th class="text-left py-1 pr-3 font-medium">이벤트 타입</th>
              <th class="text-left py-1 pr-3 font-medium">팀</th>
              <th class="text-left py-1 pr-3 font-medium">봇</th>
              <th class="text-left py-1 pr-3 font-medium w-12">심각도</th>
              <th class="text-left py-1 pr-3 font-medium">Trace</th>
              <th class="text-left py-1 font-medium">시간</th>
            </tr>
          </thead>
          <tbody>
            <%= for event <- @events do %>
              <% trace_id = event_trace_id(event) %>
              <tr class="border-b border-gray-700/50 hover:bg-gray-700/30">
                <td class="py-1 pr-3 text-gray-200 font-mono truncate max-w-[180px]">
                  {event["event_type"] || event[:event_type] || "—"}
                </td>
                <td class="py-1 pr-3 text-gray-300">
                  {event["team"] || event[:team] || "—"}
                </td>
                <td class="py-1 pr-3 text-gray-400 truncate max-w-[120px]">
                  {event["bot_name"] || event[:bot_name] || "—"}
                </td>
                <td class="py-1 pr-3">
                  <span class={"font-semibold #{severity_class(event["severity"] || event[:severity])}"}>
                    {event["severity"] || event[:severity] || "info"}
                  </span>
                </td>
                <td class="py-1 pr-3 text-blue-300 font-mono whitespace-nowrap">
                  <%= if trace_id do %>
                    <span class="inline-flex items-center gap-1">
                      <button
                        phx-click="show_trace"
                        phx-value-id={trace_id}
                        class="hover:text-blue-200 underline decoration-blue-500/50 cursor-pointer"
                        title="영역 9에서 Trace 상세 보기"
                      >
                        {short_trace_id(trace_id)}
                      </button>
                      <a
                        href={langfuse_trace_url(trace_id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-gray-500 hover:text-gray-300 text-[10px]"
                        title="Langfuse UI에서 열기"
                      >↗</a>
                    </span>
                  <% else %>
                    <span class="text-gray-700 text-[10px] opacity-60">—</span>
                  <% end %>
                </td>
                <td class="py-1 text-gray-400 whitespace-nowrap">
                  {event |> event_timestamp() |> format_event_time()}
                </td>
              </tr>
            <% end %>
          </tbody>
        </table>
        <%= if @events == [] do %>
          <div class="text-center text-gray-500 py-8 text-sm">이벤트 없음 — 연결 대기 중...</div>
        <% end %>
      </div>
    </div>
    """
  end

  # ── 영역 9: Langfuse Trace 상세 ─────────────────────────────────

  attr(:trace_id, :string, default: nil)
  attr(:trace_detail, :any, default: nil)
  attr(:trace_loading, :boolean, default: false)

  defp trace_detail_board(assigns) do
    observations =
      case assigns.trace_detail do
        %{"observations" => obs} when is_list(obs) ->
          Enum.sort_by(obs, &(&1["startTime"] || ""), :asc)

        _ ->
          []
      end

    assigns = assign(assigns, observations: observations)

    ~H"""
    <div class="bg-gray-800 rounded-xl p-5 space-y-4 border border-blue-500/30">
      <div class="flex items-center justify-between border-b border-gray-700 pb-2">
        <span class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          [9] Langfuse Trace 상세
        </span>
        <%= if @trace_id do %>
          <div class="flex items-center gap-3">
            <span class="font-mono text-[10px] text-gray-500 truncate max-w-[260px]">
              {@trace_id}
            </span>
            <button
              phx-click="close_trace"
              class="text-gray-400 hover:text-white text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
            >
              ✕ 닫기
            </button>
          </div>
        <% else %>
          <span class="text-xs text-gray-500">영역 4의 trace_id 클릭</span>
        <% end %>
      </div>

      <%= cond do %>
        <% is_nil(@trace_id) -> %>
          <div class="text-center text-gray-500 py-12 text-sm">
            Trace 선택 안 됨 — 영역 4에서 trace_id 클릭
          </div>

        <% @trace_loading -> %>
          <div class="flex items-center gap-2 text-gray-400 text-sm py-6 justify-center">
            <span>⏳</span>
            <span>Langfuse API 로딩 중...</span>
          </div>

        <% true -> %>
          <%= case @trace_detail do %>
            <% :error -> %>
              <div class="bg-red-900/20 border border-red-500/30 rounded-lg p-4 text-sm text-red-300 space-y-1">
                <div class="font-semibold">Langfuse API 오류</div>
                <div class="text-xs text-red-400">
                  LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 환경변수 확인 필요.
                  LANGFUSE_OTEL_ENABLED=true 설정 후 재시작하면 trace가 수집됩니다.
                </div>
              </div>
            <% :not_found -> %>
              <div class="bg-yellow-900/20 border border-yellow-500/30 rounded-lg p-4 text-sm text-yellow-300 space-y-1">
                <div class="font-semibold">Trace 미발견</div>
                <div class="text-xs text-yellow-400">
                  Langfuse에 아직 trace가 도달하지 않았습니다.
                  LANGFUSE_OTEL_ENABLED=true 설정 후 이벤트를 발생시키면 수집됩니다.
                </div>
              </div>
            <% nil -> %>
              <div class="text-gray-500 text-sm py-4 text-center">trace 데이터 없음</div>
            <% trace -> %>
              <.trace_meta_section trace={trace} />
              <.trace_observations_section observations={@observations} />
          <% end %>
      <% end %>
    </div>
    """
  end

  attr(:trace, :map, required: true)

  defp trace_meta_section(assigns) do
    ~H"""
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
      <div class="bg-gray-700 rounded-lg p-3">
        <div class="text-gray-400 mb-1">Trace Name</div>
        <div class="text-gray-200 font-mono truncate">{@trace["name"] || "—"}</div>
      </div>
      <div class="bg-gray-700 rounded-lg p-3">
        <div class="text-gray-400 mb-1">User</div>
        <div class="text-gray-200 truncate">{@trace["userId"] || "—"}</div>
      </div>
      <div class="bg-gray-700 rounded-lg p-3">
        <div class="text-gray-400 mb-1">Session</div>
        <div class="text-gray-200 font-mono truncate">
          {if s = @trace["sessionId"], do: String.slice(s, 0, 16), else: "—"}
        </div>
      </div>
      <div class="bg-gray-700 rounded-lg p-3">
        <div class="text-gray-400 mb-1">Spans</div>
        <div class="text-blue-300 font-semibold">
          {length(@trace["observations"] || [])}건
        </div>
      </div>
    </div>
    """
  end

  attr(:observations, :list, required: true)

  defp trace_observations_section(assigns) do
    ~H"""
    <div class="space-y-2">
      <div class="text-xs text-gray-400 font-medium uppercase tracking-wider">Span 타임라인</div>
      <%= if @observations == [] do %>
        <div class="text-center text-gray-500 py-6 text-sm">
          수집된 span 없음 — OTLP 발신 활성화 후 이벤트 발생 시 표시됩니다
        </div>
      <% else %>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-gray-400 border-b border-gray-700">
                <th class="text-left py-1 pr-3 font-medium">타입</th>
                <th class="text-left py-1 pr-3 font-medium">Span Name</th>
                <th class="text-left py-1 pr-3 font-medium">시작</th>
                <th class="text-left py-1 pr-3 font-medium w-20">소요</th>
                <th class="text-left py-1 pr-3 font-medium">모델</th>
                <th class="text-left py-1 font-medium">토큰</th>
              </tr>
            </thead>
            <tbody>
              <%= for obs <- @observations do %>
                <tr class="border-b border-gray-700/50 hover:bg-gray-700/30">
                  <td class="py-1 pr-3">
                    <span class={obs_type_class(obs["type"])}>
                      {obs_type_label(obs["type"])}
                    </span>
                  </td>
                  <td class="py-1 pr-3 text-gray-200 font-mono truncate max-w-[200px]">
                    {obs["name"] || "—"}
                  </td>
                  <td class="py-1 pr-3 text-gray-400 whitespace-nowrap">
                    {format_obs_time(obs["startTime"])}
                  </td>
                  <td class="py-1 pr-3 text-yellow-300 whitespace-nowrap">
                    {obs_duration(obs["startTime"], obs["endTime"])}
                  </td>
                  <td class="py-1 pr-3 text-purple-300 truncate max-w-[120px]">
                    {obs["model"] || obs["calculatedInputCost"] && "—" || "—"}
                  </td>
                  <td class="py-1 text-green-300">
                    {obs_tokens(obs["usage"])}
                  </td>
                </tr>
              <% end %>
            </tbody>
          </table>
        </div>
      <% end %>
    </div>
    """
  end

  defp obs_type_label("GENERATION"), do: "GEN"
  defp obs_type_label("SPAN"), do: "SPAN"
  defp obs_type_label("EVENT"), do: "EVT"
  defp obs_type_label(t) when is_binary(t), do: String.slice(t, 0, 4)
  defp obs_type_label(_), do: "—"

  defp obs_type_class("GENERATION"), do: "text-purple-400 font-semibold"
  defp obs_type_class("SPAN"), do: "text-blue-400"
  defp obs_type_class("EVENT"), do: "text-yellow-400"
  defp obs_type_class(_), do: "text-gray-400"

  defp format_obs_time(nil), do: "—"

  defp format_obs_time(iso) when is_binary(iso) do
    case DateTime.from_iso8601(iso) do
      {:ok, dt, _} ->
        kst = DateTime.add(dt, @kst_offset_seconds, :second)
        Calendar.strftime(kst, "%H:%M:%S")

      _ ->
        String.slice(iso, 11, 8)
    end
  rescue
    _ -> "—"
  end

  defp obs_duration(nil, _), do: "—"
  defp obs_duration(_, nil), do: "실행 중"

  defp obs_duration(start_iso, end_iso) when is_binary(start_iso) and is_binary(end_iso) do
    with {:ok, s, _} <- DateTime.from_iso8601(start_iso),
         {:ok, e, _} <- DateTime.from_iso8601(end_iso) do
      ms = DateTime.diff(e, s, :millisecond)

      cond do
        ms < 1_000 -> "#{ms}ms"
        ms < 60_000 -> "#{Float.round(ms / 1_000, 1)}s"
        true -> "#{div(ms, 60_000)}m #{rem(div(ms, 1_000), 60)}s"
      end
    else
      _ -> "—"
    end
  rescue
    _ -> "—"
  end

  defp obs_tokens(nil), do: "—"

  defp obs_tokens(usage) when is_map(usage) do
    total = usage["totalTokens"] || usage["total_tokens"]
    if total, do: "#{total}tok", else: "—"
  end

  defp obs_tokens(_), do: "—"

  # ── 영역 2: 협업 타임라인 ───────────────────────────────────────

  attr(:cycles, :list, required: true)
  attr(:active_sessions, :list, required: true)

  defp collab_timeline_board(assigns) do
    ~H"""
    <div class="bg-gray-800 rounded-xl p-5 space-y-4">
      <div class="flex items-center justify-between border-b border-gray-700 pb-2">
        <span class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          [2] 협업 타임라인
        </span>
        <span class="text-xs text-gray-400">최근 5 cycle</span>
      </div>

      <%= if @cycles == [] do %>
        <div class="text-center text-gray-500 py-8 text-sm">
          cycle_id 기반 협업 이벤트 없음 — 마스터/메티/코덱스 trace 대기 중...
        </div>
      <% else %>
        <div class="space-y-3 max-h-[760px] overflow-y-auto pr-1">
          <%= for cycle <- @cycles do %>
            <section class="bg-gray-900/70 border border-gray-700 rounded-lg p-3 space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-white">Cycle {cycle.cycle_id}</span>
                <span class="text-xs text-gray-500">{length(cycle.events)} events</span>
              </div>

              <div class="space-y-2">
                <%= for event <- cycle.events do %>
                  <div class="flex gap-2 border-l border-gray-700 pl-3">
                    <div class="text-lg leading-6">{bot_emoji(event.bot_name)}</div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="text-xs text-gray-400">{event.bot_name || "unknown"}</span>
                        <span class={"text-[10px] font-semibold #{severity_class(event.severity)}"}>
                          {event.severity || "info"}
                        </span>
                      </div>
                      <div class="text-sm text-gray-100 truncate">
                        {event.title || collab_event_label(event.event_type)}
                      </div>
                      <div class="text-[11px] text-gray-500 font-mono truncate">
                        {event.event_type}
                      </div>
                      <div class="text-[11px] text-gray-500">
                        {format_event_time(event.created_at)}
                      </div>
                    </div>
                  </div>
                <% end %>
              </div>
            </section>
          <% end %>
        </div>
      <% end %>

      <div class="border-t border-gray-700 pt-3 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">활성 세션</span>
          <span class="text-[10px] text-gray-500">{length(@active_sessions)} active</span>
        </div>
        <%= if @active_sessions == [] do %>
          <div class="text-center text-gray-600 py-3 text-xs">활성 project session 없음</div>
        <% else %>
          <div class="space-y-2">
            <%= for session <- @active_sessions do %>
              <div class="bg-gray-900/70 border border-gray-700 rounded-lg p-2">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs text-gray-200">{bot_emoji(session.agent_type)} {session.agent_type}</span>
                  <span class="text-[10px] text-gray-500">{format_relative_time(session.started_at)}</span>
                </div>
                <div class="text-[11px] text-gray-400 truncate mt-1">{session.summary || session.id}</div>
                <div class="text-[10px] text-gray-600 truncate mt-1">
                  files: {Enum.join(session.files_touched || [], " · ")}
                </div>
              </div>
            <% end %>
          </div>
        <% end %>
      </div>
    </div>
    """
  end

  # ── 영역 5: 크로스팀 파이프라인 보드 ────────────────────────────

  attr(:cross_pipelines, :map, required: true)

  defp cross_team_board(assigns) do
    assigns = assign(assigns, :pipelines_meta, @pipelines_meta)

    ~H"""
    <div class="bg-gray-800 rounded-xl p-5 space-y-4">
      <div class="flex items-center justify-between border-b border-gray-700 pb-2">
        <span class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          [5] 크로스팀 파이프라인
        </span>
        <span class="text-xs text-gray-400">최근 24시간</span>
      </div>

      <div class="space-y-2">
        <%= for {key, label, emoji} <- @pipelines_meta do %>
          <% pipeline = Map.get(@cross_pipelines, key, %{}) %>
          <div class={pipeline_card_class(key)}>
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-base shrink-0">{emoji}</span>
              <span class="text-xs font-medium text-gray-300 truncate">{label}</span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <span class={pipeline_count_class(pipeline[:count])}>
                {pipeline[:count] || 0}회
              </span>
              <span class="text-[10px] text-gray-500">
                {pipeline_status_summary(pipeline[:status_counts])}
              </span>
              <span class="text-[10px] text-gray-500">
                {format_relative_time(pipeline[:last_at])}
              </span>
            </div>
          </div>
        <% end %>
      </div>
    </div>
    """
  end

  # ── 영역 6: 팀 헬스 보드 ─────────────────────────────────────────

  attr(:team_health, :map, required: true)

  defp team_health_board(assigns) do
    assigns = assign(assigns, :teams_meta, @teams_meta)

    ~H"""
    <div class="bg-gray-800 rounded-xl p-5 space-y-4">
      <div class="flex items-center justify-between border-b border-gray-700 pb-2">
        <span class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          [6] 팀 헬스
        </span>
        <span class="text-xs text-gray-400">이벤트 기반</span>
      </div>

      <div class="space-y-1.5">
        <%= for %{key: key, label: label, emoji: emoji} <- @teams_meta do %>
          <% health = Map.get(@team_health, key, %{}) %>
          <% status = team_health_status(key, health) %>
          <div class="bg-gray-900/70 border border-gray-700 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-sm shrink-0">{emoji}</span>
              <span class="text-xs font-medium text-gray-300">{label}</span>
              <%= if key == "ska" and health[:andy_status] do %>
                <span class="text-[10px] text-gray-500">
                  A:{agent_status_emoji(health[:andy_status])} J:{agent_status_emoji(health[:jimmy_status])}
                </span>
              <% end %>
            </div>
            <div class="flex items-center gap-2 shrink-0 text-right">
              <span class="text-[10px] text-gray-500">{health[:event_count] || 0}건</span>
              <span class="text-[10px] text-gray-500">{format_relative_time(health[:last_at])}</span>
              <span class={"text-[10px] font-semibold #{team_status_class(status)}"}>
                {team_status_label(status)}
              </span>
            </div>
          </div>
        <% end %>
      </div>
    </div>
    """
  end

  # ── 영역 7: Sigma 메타 보드 ─────────────────────────────────────

  attr(:sigma_status, :map, required: true)

  defp sigma_board(assigns) do
    mapek = assigns.sigma_status[:mapek] || %{}

    event_activity =
      assigns.sigma_status[:event_activity] || %{count: 0, last_at: nil}

    assigns =
      assign(assigns,
        event_activity: event_activity,
        mapek: mapek,
        mapek_cycle_count: mapek_cycle_count(mapek),
        mapek_current_phase: mapek_current_phase(mapek),
        mapek_last_at: mapek_last_at(mapek),
        mapek_phases: @mapek_phases,
        pods_meta: @pods_meta
      )

    ~H"""
    <div class="bg-gray-800 rounded-xl p-5 space-y-4">
      <div class="flex items-center justify-between border-b border-gray-700 pb-2">
        <span class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          [7] Sigma 메타
        </span>
        <span class="text-xs text-gray-400">cycle: {@mapek_cycle_count}</span>
      </div>

      <div class="bg-gray-900/70 border border-gray-700 rounded-lg p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs text-gray-400">MAPE-K Loop</span>
          <span class={mapek_dormant_class(@mapek)}>
            {if @mapek[:dormant], do: "dormant", else: "active"}
          </span>
        </div>
        <div class="flex items-center gap-1 text-xs">
          <%= for phase <- @mapek_phases do %>
            <span class={mapek_phase_class(@mapek_current_phase, phase)}>
              {phase}
            </span>
          <% end %>
          <span class="text-[10px] text-gray-500 ml-2">
            마지막: {format_relative_time(@mapek_last_at)}
          </span>
        </div>
        <div class="mt-2 text-[10px] text-gray-400">
          EventLake 24h: <span class="text-blue-300">{@event_activity[:count] || 0}건</span>
          · {format_relative_time(@event_activity[:last_at])}
        </div>
      </div>

      <div class="bg-gray-900/70 border border-gray-700 rounded-lg p-3 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="text-base">🎯</span>
          <span class="text-xs text-gray-300">Commander</span>
          <span class="text-[10px] text-gray-500">(smart)</span>
        </div>
        <span class={alive_class(@sigma_status[:commander_alive])}>
          {if @sigma_status[:commander_alive], do: "● 가동", else: "○ 정지"}
        </span>
      </div>

      <div class="grid grid-cols-1 gap-2">
        <%= for {emoji, label, key, analysts} <- @pods_meta do %>
          <% alive = Map.get(@sigma_status, key, false) %>
          <div class="bg-gray-900/70 border border-gray-700 rounded-lg p-2.5">
            <div class="flex items-center justify-between">
              <span class="text-xs text-gray-300">{emoji} {label}</span>
              <span class={alive_class(alive)}>{if alive, do: "●", else: "○"}</span>
            </div>
            <div class="text-[10px] text-gray-500 mt-0.5">
              {Enum.join(analysts, " · ")}
            </div>
          </div>
        <% end %>
      </div>
    </div>
    """
  end

  # ── 영역 8: Luna 매매 흐름 보드 ─────────────────────────────────

  attr(:luna_pipeline, :map, required: true)

  defp luna_flow_board(assigns) do
    circuit = Map.get(assigns.luna_pipeline, :circuit_breaker, %{count: 0, last_at: nil})
    assigns = assign(assigns, luna_stages_meta: @luna_stages_meta, circuit: circuit)

    ~H"""
    <div class="bg-gray-800 rounded-xl p-5 space-y-4">
      <div class="flex items-center justify-between border-b border-gray-700 pb-2">
        <span class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          [8] Luna 매매 흐름
        </span>
        <span class="text-xs text-gray-400">EventLake + DB 24h</span>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
        <%= for {emoji, label, stage} <- @luna_stages_meta do %>
          <% stage_data = Map.get(@luna_pipeline, stage, %{count: 0, last_at: nil}) %>
          <div class={luna_stage_class(stage_data)}>
            <div class="text-base">{emoji}</div>
            <div class="text-[10px] text-gray-300 truncate">{label}</div>
            <div class="text-xs font-semibold mt-1">{stage_data[:count] || 0}</div>
            <div class="text-[9px] text-gray-500">{format_relative_time(stage_data[:last_at])}</div>
          </div>
        <% end %>
      </div>

      <%= if (@circuit[:count] || 0) > 0 do %>
        <div class="bg-red-950/40 border border-red-500/60 rounded-lg p-2 text-xs text-red-300">
          🚨 Circuit Breaker 발동: {@circuit[:count]}건 · {format_relative_time(@circuit[:last_at])}
        </div>
      <% else %>
        <div class="bg-gray-900/70 border border-gray-700 rounded-lg p-2 text-xs text-gray-500">
          Circuit Breaker: 24시간 내 감지 없음
        </div>
      <% end %>
    </div>
    """
  end

  # ── 영역 10: Project + Milestone 보드 ─────────────────────────────

  attr(:projects, :list, required: true)
  attr(:metrics, :map, required: true)
  attr(:tasks_by_stage, :map, required: true)
  attr(:milestones, :list, required: true)
  attr(:kanban_stages, :list, required: true)
  attr(:selected_task, :any, required: true)
  attr(:schema_ready, :boolean, required: true)
  attr(:config_path, :string, required: true)
  attr(:project_error, :any, required: true)

  defp project_milestone_board(assigns) do
    ~H"""
    <div class="bg-gray-800 rounded-xl p-5 space-y-4 border border-emerald-500/20">
      <div class="flex items-center justify-between border-b border-gray-700 pb-2">
        <span class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          [10] Project + Milestone 보드
        </span>
        <span class={project_schema_badge(@schema_ready)}>
          {if @schema_ready, do: "project schema live", else: "marker fallback"}
        </span>
      </div>

      <div class="grid grid-cols-2 lg:grid-cols-5 gap-2 text-xs">
        <.metric_card label="Projects" value={@metrics[:active_projects] || 0} tone="green" />
        <.metric_card label="Sessions" value={@metrics[:active_sessions] || 0} tone="blue" />
        <.metric_card label="Building" value={get_in(@metrics, [:by_stage, "building"]) || 0} tone="amber" />
        <.metric_card label="Observe Warn" value={@metrics[:observe_warnings] || 0} tone="purple" />
        <.metric_card label="Conflicts" value={@metrics[:conflicts] || 0} tone="red" />
      </div>

      <div class="text-[10px] text-gray-500 truncate">
        whitelist: {@config_path}
      </div>

      <%= if @project_error do %>
        <div class="bg-red-950/40 border border-red-500/40 rounded-lg p-2 text-xs text-red-300">
          {@project_error}
        </div>
      <% end %>

      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <%= for project <- @projects do %>
          <div class={"rounded-lg p-3 border #{project_color_class(project.color)}"}>
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-sm font-semibold text-white truncate">{project.name}</div>
                <div class="text-xs text-gray-400 mt-0.5 truncate">{project.phase}</div>
              </div>
              <span class="text-[10px] text-gray-500">{project_task_count(@tasks_by_stage, project.id)} tasks</span>
            </div>
            <div class="mt-3">
              <div class="h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  class={"h-full rounded-full #{project_progress_color(project.progress)}"}
                  style={"width: #{round((project.progress || 0) * 100)}%"}
                />
              </div>
              <div class="text-[10px] text-gray-500 mt-1">
                {round((project.progress || 0) * 100)}% · {owner_label(project.owner)}
              </div>
            </div>
          </div>
        <% end %>
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-5 gap-2">
        <%= for stage <- @kanban_stages do %>
          <% tasks = Map.get(@tasks_by_stage, stage.stage, []) %>
          <div class={"rounded-lg p-2 border border-gray-700 #{stage.class}"}>
            <div class="flex items-center justify-between text-xs font-semibold text-gray-300 mb-2">
              <span>{stage.icon} {stage.label}</span>
              <span class="text-gray-500">{length(tasks)}</span>
            </div>
            <div class="space-y-1 max-h-64 overflow-y-auto pr-1">
              <%= for task <- tasks do %>
                <button
                  type="button"
                  phx-click="task_view"
                  phx-value-id={task.id}
                  class="w-full text-left bg-gray-950/60 hover:bg-gray-700/80 rounded p-2 transition-colors"
                >
                  <div class="text-[11px] text-gray-100 truncate">{task.title}</div>
                  <div class="text-[9px] text-gray-500 mt-0.5 truncate">
                    {task.assignee || "—"} · {format_elapsed(task.elapsed_seconds)} · {task.project_id}
                    <span class={task_stale_class(task.started_at)}> · {days_since_started(task.started_at)}d</span>
                  </div>
                </button>
              <% end %>
              <%= if tasks == [] do %>
                <div class="text-center text-[10px] text-gray-600 py-6">비어 있음</div>
              <% end %>
            </div>
          </div>
        <% end %>
      </div>

      <%= if @selected_task do %>
        <.project_task_detail task={@selected_task} kanban_stages={@kanban_stages} />
      <% end %>

      <div class="border-t border-gray-700 pt-3">
        <div class="text-xs font-semibold text-gray-400 mb-2">마일스톤 (다가오는 8개)</div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-2">
          <%= for milestone <- @milestones do %>
            <div class={"flex items-center gap-2 text-xs rounded-lg bg-gray-900/60 border border-gray-700 px-3 py-2 #{milestone_status_class(milestone.status)}"}>
              <span class="font-mono text-gray-500 w-20">{format_project_date(milestone.date)}</span>
              <span class={"px-1.5 py-0.5 rounded text-[10px] #{milestone_badge(milestone.status)}"}>
                {milestone.status}
              </span>
              <span class="text-gray-300 truncate">{milestone.title}</span>
              <span class="text-gray-500 ml-auto whitespace-nowrap">{milestone.owner}</span>
            </div>
          <% end %>
        </div>
      </div>
    </div>
    """
  end

  attr(:label, :string, required: true)
  attr(:value, :any, required: true)
  attr(:tone, :string, required: true)

  defp metric_card(assigns) do
    ~H"""
    <div class={"rounded-lg border p-2 #{metric_card_class(@tone)}"}>
      <div class="text-[10px] text-gray-400">{@label}</div>
      <div class="text-lg font-bold text-white">{@value}</div>
    </div>
    """
  end

  attr(:task, :map, required: true)
  attr(:kanban_stages, :list, required: true)

  defp project_task_detail(assigns) do
    ~H"""
    <div class="bg-gray-950/70 border border-gray-700 rounded-lg p-3 space-y-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-sm font-semibold text-white truncate">{@task.title}</div>
          <div class="text-[11px] text-gray-500 font-mono truncate">
            {@task.id} · {@task.project_id} · {@task.assignee || "unassigned"}
          </div>
        </div>
        <button
          phx-click="close_task"
          class="text-gray-500 hover:text-white text-xs px-2 py-1 rounded bg-gray-800"
        >
          닫기
        </button>
      </div>

      <div class="flex flex-wrap gap-1.5">
        <%= for stage <- @kanban_stages do %>
          <button
            type="button"
            phx-click="task_stage_change"
            phx-value-id={@task.id}
            phx-value-stage={stage.stage}
            class={task_stage_button_class(@task.stage, stage.stage)}
          >
            {stage.icon} {stage.label}
          </button>
        <% end %>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] text-gray-400">
        <div>시작: {format_datetime(@task.started_at)}</div>
        <div>종료: {format_datetime(@task.finished_at)}</div>
        <div>경과: {format_elapsed(@task.elapsed_seconds)}</div>
      </div>
    </div>
    """
  end

  # ── 영역 11: TimelineGantt 2주 ──────────────────────────────────

  attr(:gantt, :map, required: true)

  defp timeline_gantt_board(assigns) do
    ~H"""
    <div class="bg-gray-800 rounded-xl p-5 space-y-4 border border-cyan-500/20">
      <div class="flex items-center justify-between border-b border-gray-700 pb-2">
        <span class="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          [11] TimelineGantt 2주
        </span>
        <span class="text-xs text-gray-500">
          {format_project_date(@gantt.start_date)} ~ {format_project_date(@gantt.end_date)}
        </span>
      </div>

      <div class="overflow-x-auto">
        <div class="min-w-[1040px] space-y-1">
          <div class="grid gap-1" style={"grid-template-columns: 170px repeat(15, minmax(48px, 1fr));"}>
            <div class="text-[10px] text-gray-500">Project</div>
            <%= for date <- @gantt.dates do %>
              <div class="text-[10px] text-gray-500 text-center">{format_project_date(date)}</div>
            <% end %>
          </div>

          <%= for project <- @gantt.projects do %>
            <div class="grid gap-1 items-stretch" style={"grid-template-columns: 170px repeat(15, minmax(48px, 1fr));"}>
              <div class="bg-gray-900/70 border border-gray-700 rounded px-2 py-2 text-xs text-gray-200 truncate">
                {project.name}
              </div>
              <%= for date <- @gantt.dates do %>
                <% items = gantt_items_for_date(@gantt, project.id, date) %>
                <div class="min-h-12 bg-gray-950/50 border border-gray-800 rounded p-1 space-y-1">
                  <%= for task <- items.tasks do %>
                    <div class={"h-2 rounded-full #{stage_dot_class(task.stage)}"} title={task.title}></div>
                  <% end %>
                  <%= for ms <- items.milestones do %>
                    <div class="flex items-center justify-center" title={ms.title}>
                      <span class={"inline-block w-2.5 h-2.5 rounded-full #{milestone_dot_class(ms.status)}"}></span>
                    </div>
                  <% end %>
                </div>
              <% end %>
            </div>
          <% end %>
        </div>
      </div>
    </div>
    """
  end

  # ── 헬퍼 ────────────────────────────────────────────────────────

  # ── Phase G: Project/Milestone 헬퍼 ─────────────────────────────

  defp safe_project_topics, do: @project_topics

  defp project_topic?(topic_text) when is_binary(topic_text),
    do:
      String.starts_with?(topic_text, "project.task.") or
        String.starts_with?(topic_text, "project.milestone.")

  defp project_topic?(_), do: false

  defp load_project_visibility do
    TeamJay.Dashboard.ProjectVisibility.snapshot()
  rescue
    _ ->
      %{
        schema_ready?: false,
        config_path: TeamJay.Dashboard.ProjectVisibility.config_path(),
        projects: [],
        tasks_by_stage: %{},
        milestones: [],
        active_sessions: [],
        metrics: %{
          active_projects: 0,
          active_sessions: 0,
          by_stage: %{},
          observe_warnings: 0,
          conflicts: 0
        },
        gantt: %{
          start_date: kst_today(),
          end_date: kst_today(),
          dates: [],
          projects: [],
          tasks_by_project: %{},
          milestones_by_project: %{}
        }
      }
  end

  defp refresh_project_visibility(socket) do
    assign_project_visibility(socket, load_project_visibility())
  end

  defp assign_project_visibility(socket, visibility) do
    socket
    |> assign(:project_schema_ready?, visibility[:schema_ready?] || false)
    |> assign(
      :projects_config_path,
      visibility[:config_path] || TeamJay.Dashboard.ProjectVisibility.config_path()
    )
    |> assign(:projects, visibility[:projects] || [])
    |> assign(:tasks_by_stage, visibility[:tasks_by_stage] || %{})
    |> assign(:milestones, visibility[:milestones] || [])
    |> assign(:active_sessions, visibility[:active_sessions] || [])
    |> assign(:project_metrics, visibility[:metrics] || %{})
    |> assign(:gantt_data, visibility[:gantt] || %{})
  end

  defp find_project_task(tasks_by_stage, task_id) do
    tasks_by_stage
    |> Map.values()
    |> List.flatten()
    |> Enum.find(&(&1.id == task_id))
  end

  defp project_schema_badge(true),
    do:
      "text-[10px] font-semibold text-green-300 bg-green-950/50 border border-green-500/40 rounded-full px-2 py-0.5"

  defp project_schema_badge(_),
    do:
      "text-[10px] font-semibold text-yellow-300 bg-yellow-950/50 border border-yellow-500/40 rounded-full px-2 py-0.5"

  defp metric_card_class("green"), do: "bg-green-950/30 border-green-500/40"
  defp metric_card_class("blue"), do: "bg-blue-950/30 border-blue-500/40"
  defp metric_card_class("amber"), do: "bg-amber-950/30 border-amber-500/40"
  defp metric_card_class("purple"), do: "bg-purple-950/30 border-purple-500/40"
  defp metric_card_class("red"), do: "bg-red-950/30 border-red-500/40"
  defp metric_card_class(_), do: "bg-gray-900/40 border-gray-700"

  defp project_color_class("green"), do: "border-green-500/50 bg-green-950/25"
  defp project_color_class("amber"), do: "border-amber-500/50 bg-amber-950/25"
  defp project_color_class("purple"), do: "border-purple-500/50 bg-purple-950/25"
  defp project_color_class("blue"), do: "border-blue-500/50 bg-blue-950/25"
  defp project_color_class(_), do: "border-gray-700 bg-gray-900/40"

  defp project_progress_color(progress) when is_number(progress) and progress < 0.3,
    do: "bg-amber-500"

  defp project_progress_color(progress) when is_number(progress) and progress < 0.7,
    do: "bg-blue-500"

  defp project_progress_color(_), do: "bg-green-500"

  defp owner_label(owner) when is_list(owner), do: Enum.join(owner, ", ")
  defp owner_label(owner) when is_binary(owner), do: owner
  defp owner_label(_), do: "—"

  defp project_task_count(tasks_by_stage, project_id) do
    tasks_by_stage
    |> Map.values()
    |> List.flatten()
    |> Enum.count(&(&1.project_id == project_id))
  end

  defp milestone_status_class("achieved"), do: "opacity-60"
  defp milestone_status_class("missed"), do: "text-red-300 border-red-500/40"
  defp milestone_status_class(_), do: ""

  defp milestone_badge("achieved"), do: "bg-green-900/50 text-green-300"
  defp milestone_badge("missed"), do: "bg-red-900/50 text-red-300"
  defp milestone_badge(_), do: "bg-blue-900/50 text-blue-300"

  defp milestone_dot_class("achieved"), do: "bg-green-400"
  defp milestone_dot_class("missed"), do: "bg-red-400"
  defp milestone_dot_class(_), do: "bg-blue-400"

  defp stage_dot_class("building"), do: "bg-blue-500"
  defp stage_dot_class("verify"), do: "bg-amber-500"
  defp stage_dot_class("observing"), do: "bg-purple-500"
  defp stage_dot_class("done"), do: "bg-green-500"
  defp stage_dot_class(_), do: "bg-gray-500"

  defp task_stage_button_class(current_stage, stage) do
    base = "text-[10px] rounded-full px-2 py-1 border transition-colors"

    if current_stage == stage do
      "#{base} bg-blue-600 border-blue-400 text-white"
    else
      "#{base} bg-gray-900 border-gray-700 text-gray-400 hover:text-white hover:border-gray-500"
    end
  end

  defp format_elapsed(nil), do: "—"
  defp format_elapsed(seconds) when is_integer(seconds) and seconds < 60, do: "#{seconds}s"

  defp format_elapsed(seconds) when is_integer(seconds) and seconds < 3_600,
    do: "#{div(seconds, 60)}m"

  defp format_elapsed(seconds) when is_integer(seconds) and seconds < 86_400,
    do: "#{div(seconds, 3_600)}h"

  defp format_elapsed(seconds) when is_integer(seconds), do: "#{div(seconds, 86_400)}d"
  defp format_elapsed(_), do: "—"

  defp format_project_date(%Date{} = date), do: Calendar.strftime(date, "%m-%d")

  defp format_project_date(%NaiveDateTime{} = dt),
    do: dt |> NaiveDateTime.to_date() |> format_project_date()

  defp format_project_date(%DateTime{} = dt),
    do: dt |> DateTime.to_date() |> format_project_date()

  defp format_project_date(value) when is_binary(value), do: String.slice(value, 5, 5)
  defp format_project_date(_), do: "—"

  defp gantt_items_for_date(gantt, project_id, date) do
    tasks =
      gantt
      |> Map.get(:tasks_by_project, %{})
      |> Map.get(project_id, [])
      |> Enum.filter(&task_on_date?(&1, date))
      |> Enum.take(2)

    milestones =
      gantt
      |> Map.get(:milestones_by_project, %{})
      |> Map.get(project_id, [])
      |> Enum.filter(&(to_date(&1.date) == date))

    %{tasks: tasks, milestones: milestones}
  end

  defp task_on_date?(task, date) do
    start_date = to_date(task.started_at)
    end_date = task.finished_at |> to_date() |> Kernel.||(kst_today())
    Date.compare(date, start_date) in [:eq, :gt] and Date.compare(date, end_date) in [:eq, :lt]
  rescue
    _ -> false
  end

  defp to_date(nil), do: nil
  defp to_date(%Date{} = date), do: date
  defp to_date(%NaiveDateTime{} = dt), do: NaiveDateTime.to_date(dt)
  defp to_date(%DateTime{} = dt), do: DateTime.to_date(dt)

  defp to_date(value) when is_binary(value) do
    value
    |> String.slice(0, 10)
    |> Date.from_iso8601()
    |> case do
      {:ok, date} -> date
      _ -> nil
    end
  end

  defp to_date(_), do: nil

  # ── Phase D: Sigma/Luna 헬퍼 ───────────────────────────────────

  defp safe_luna_topics, do: @luna_topic_prefixes

  defp safe_jay_bus_subscribe(topic) do
    Jay.Core.JayBus.subscribe(topic, dashboard: :luna_flow)
    Jay.Core.JayBus.subscribe(topic_to_string(topic), dashboard: :luna_flow)
  rescue
    _ -> :ok
  end

  defp load_sigma_status do
    mapek =
      safe_call(fn -> Sigma.V2.MapeKLoop.status() end, %{
        total_cycles: 0,
        last_cycle_at: nil,
        dormant: true
      })

    %{
      mapek: mapek,
      commander_alive: Process.whereis(Sigma.V2.Commander) != nil,
      trend_alive: Process.whereis(Sigma.V2.Pod.Trend) != nil,
      growth_alive: Process.whereis(Sigma.V2.Pod.Growth) != nil,
      risk_alive: Process.whereis(Sigma.V2.Pod.Risk) != nil,
      event_activity: load_sigma_event_activity()
    }
  rescue
    _ ->
      %{
        mapek: %{total_cycles: 0, last_cycle_at: nil, dormant: true},
        commander_alive: false,
        trend_alive: false,
        growth_alive: false,
        risk_alive: false,
        event_activity: %{count: 0, last_at: nil}
      }
  end

  defp load_sigma_event_activity do
    sql = """
    SELECT COUNT(*)::int AS cnt, MAX(created_at) AS last_at
    FROM agent.event_lake
    WHERE created_at > NOW() - INTERVAL '24 hours'
      AND (
        team = 'sigma'
        OR bot_name ILIKE '%sigma%'
        OR event_type ILIKE '%sigma%'
      )
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[count, last_at]]}} -> %{count: count || 0, last_at: last_at}
      _ -> %{count: 0, last_at: nil}
    end
  rescue
    _ -> %{count: 0, last_at: nil}
  end

  defp init_luna_pipeline do
    %{
      market_data: %{count: 0, last_at: nil, recent: []},
      analyst: %{count: 0, last_at: nil, recent: []},
      decision: %{count: 0, last_at: nil, recent: []},
      policy: %{count: 0, last_at: nil, recent: []},
      execution: %{count: 0, last_at: nil, recent: []},
      review: %{count: 0, last_at: nil, recent: []},
      circuit_breaker: %{count: 0, last_at: nil, recent: []}
    }
  end

  defp load_luna_pipeline_seed do
    sql = """
    SELECT event_type, COUNT(*) AS cnt, MAX(created_at) AS last_at
    FROM agent.event_lake
    WHERE event_type LIKE 'luna.%'
      AND created_at > NOW() - INTERVAL '24 hours'
    GROUP BY event_type
    """

    base = init_luna_pipeline()

    event_seed =
      case Jay.Core.Repo.query(sql, []) do
        {:ok, %{rows: rows}} ->
          Enum.reduce(rows, base, fn [event_type, cnt, last_at], acc ->
            stage = topic_to_stage(event_type)

            if stage == :other do
              acc
            else
              existing = Map.get(acc, stage, %{count: 0, last_at: nil, recent: []})

              Map.put(acc, stage, %{
                count: (existing[:count] || 0) + cnt,
                last_at: pick_later(existing[:last_at], last_at),
                recent: existing[:recent] || []
              })
            end
          end)

        _ ->
          base
      end

    merge_luna_pipeline_seed(event_seed, load_luna_operational_seed())
  rescue
    _ -> init_luna_pipeline()
  end

  defp load_luna_operational_seed do
    sql = """
    SELECT stage, SUM(cnt)::int AS cnt, MAX(last_at) AS last_at
    FROM (
      SELECT 'analyst' AS stage, COUNT(*)::int AS cnt,
             MAX(COALESCE(updated_at, last_backtest_at, created_at)) AS last_at
      FROM investment.candidate_backtest_status
      WHERE COALESCE(updated_at, last_backtest_at, created_at) > NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'analyst' AS stage, COUNT(*)::int AS cnt, MAX(created_at) AS last_at
      FROM investment.predictive_validation_log
      WHERE created_at > NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'decision' AS stage, COUNT(*)::int AS cnt, MAX(discovered_at) AS last_at
      FROM investment.candidate_universe
      WHERE discovered_at > NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'decision' AS stage, COUNT(*)::int AS cnt,
             MAX(COALESCE(updated_at, created_at)) AS last_at
      FROM investment.luna_promotion_entry_trigger_bridge_shadow
      WHERE COALESCE(updated_at, created_at) > NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'policy' AS stage, COUNT(*)::int AS cnt, MAX(observed_at) AS last_at
      FROM investment.luna_candidate_quality_governance_shadow
      WHERE observed_at > NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'policy' AS stage, COUNT(*)::int AS cnt, MAX(observed_at) AS last_at
      FROM investment.luna_candidate_bottleneck_shadow
      WHERE observed_at > NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'execution' AS stage, COUNT(*)::int AS cnt,
             MAX(COALESCE(updated_at, fired_at, created_at)) AS last_at
      FROM investment.entry_triggers
      WHERE COALESCE(updated_at, fired_at, created_at) > NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'execution' AS stage, COUNT(*)::int AS cnt, MAX(executed_at) AS last_at
      FROM investment.trades
      WHERE executed_at > NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'review' AS stage, COUNT(*)::int AS cnt, MAX(created_at) AS last_at
      FROM investment.position_reevaluation_runs
      WHERE created_at > NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'review' AS stage, COUNT(*)::int AS cnt,
             MAX(COALESCE(reviewed_at, created_at)) AS last_at
      FROM investment.position_closeout_reviews
      WHERE COALESCE(reviewed_at, created_at) > NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'review' AS stage, COUNT(*)::int AS cnt, MAX(evaluated_at) AS last_at
      FROM investment.trade_quality_evaluations
      WHERE evaluated_at > NOW() - INTERVAL '24 hours'
    ) s
    WHERE last_at IS NOT NULL
    GROUP BY stage
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Enum.reduce(rows, init_luna_pipeline(), fn [stage_name, cnt, last_at], acc ->
          case luna_stage_from_operational_name(stage_name) do
            nil ->
              acc

            stage ->
              existing = Map.get(acc, stage, %{count: 0, last_at: nil, recent: []})

              Map.put(acc, stage, %{
                count: (existing[:count] || 0) + (cnt || 0),
                last_at: pick_later(existing[:last_at], last_at),
                recent: existing[:recent] || []
              })
          end
        end)

      _ ->
        init_luna_pipeline()
    end
  rescue
    _ -> init_luna_pipeline()
  end

  defp luna_stage_from_operational_name("analyst"), do: :analyst
  defp luna_stage_from_operational_name("decision"), do: :decision
  defp luna_stage_from_operational_name("policy"), do: :policy
  defp luna_stage_from_operational_name("execution"), do: :execution
  defp luna_stage_from_operational_name("review"), do: :review
  defp luna_stage_from_operational_name(_), do: nil

  defp merge_luna_pipeline_seed(current, seed) do
    Enum.reduce(init_luna_pipeline(), current, fn {stage, default_stage}, acc ->
      current_stage = Map.get(acc, stage, default_stage)
      seed_stage = Map.get(seed, stage, default_stage)

      Map.put(acc, stage, %{
        count: max(current_stage[:count] || 0, seed_stage[:count] || 0),
        last_at: pick_later(current_stage[:last_at], seed_stage[:last_at]),
        recent: current_stage[:recent] || []
      })
    end)
  end

  defp luna_topic?(topic_text) when is_binary(topic_text),
    do: String.starts_with?(topic_text, "luna.")

  defp luna_topic?(_), do: false

  defp topic_to_stage(topic) do
    topic_text = topic_to_string(topic)

    cond do
      String.starts_with?(topic_text, "luna.tv.") -> :market_data
      String.starts_with?(topic_text, "luna.binance.") -> :market_data
      String.starts_with?(topic_text, "luna.kis.") -> :market_data
      String.starts_with?(topic_text, "luna.analyst.") -> :analyst
      String.starts_with?(topic_text, "luna.decision.") -> :decision
      String.starts_with?(topic_text, "luna.policy.") -> :policy
      String.starts_with?(topic_text, "luna.execution.") -> :execution
      String.starts_with?(topic_text, "luna.review.") -> :review
      String.starts_with?(topic_text, "luna.circuit.") -> :circuit_breaker
      true -> :other
    end
  end

  defp update_luna_pipeline(luna_pipeline, :other, _topic, _payload), do: luna_pipeline

  defp update_luna_pipeline(luna_pipeline, stage, topic, payload) do
    now = DateTime.utc_now()
    existing = Map.get(luna_pipeline, stage, %{count: 0, last_at: nil, recent: []})

    recent =
      [%{topic: topic, payload: payload, at: now} | existing[:recent] || []] |> Enum.take(5)

    Map.put(luna_pipeline, stage, %{
      count: (existing[:count] || 0) + 1,
      last_at: now,
      recent: recent
    })
  end

  defp topic_to_string(topic) when is_atom(topic), do: Atom.to_string(topic)
  defp topic_to_string(topic) when is_binary(topic), do: topic
  defp topic_to_string(topic), do: to_string(topic)

  defp mapek_cycle_count(mapek) when is_map(mapek),
    do:
      mapek[:cycle_count] || mapek["cycle_count"] || mapek[:total_cycles] || mapek["total_cycles"] ||
        0

  defp mapek_cycle_count(_), do: 0

  defp mapek_current_phase(mapek) when is_map(mapek) do
    phase = mapek[:current_phase] || mapek["current_phase"] || mapek[:phase] || mapek["phase"]

    cond do
      is_binary(phase) and String.trim(phase) != "" ->
        phase |> String.first() |> String.upcase()

      mapek[:dormant] || mapek["dormant"] ->
        "—"

      true ->
        "M"
    end
  end

  defp mapek_current_phase(_), do: "—"

  defp mapek_last_at(mapek) when is_map(mapek) do
    mapek[:last_at] || mapek["last_at"] || mapek[:last_cycle_at] || mapek["last_cycle_at"] ||
      mapek[:last_monitor_at] || mapek["last_monitor_at"] || mapek[:started_at] ||
      mapek["started_at"]
  end

  defp mapek_last_at(_), do: nil

  defp mapek_phase_class(current_phase, phase) do
    if current_phase == phase do
      "inline-flex items-center justify-center w-7 h-7 rounded bg-blue-500 text-white font-bold"
    else
      "inline-flex items-center justify-center w-7 h-7 rounded bg-gray-700 text-gray-400"
    end
  end

  defp mapek_dormant_class(%{dormant: true}), do: "text-[10px] text-yellow-400"
  defp mapek_dormant_class(%{"dormant" => true}), do: "text-[10px] text-yellow-400"
  defp mapek_dormant_class(_), do: "text-[10px] text-green-400"

  defp alive_class(true), do: "text-[10px] font-semibold text-green-400"
  defp alive_class(_), do: "text-[10px] font-semibold text-gray-500"

  defp luna_stage_class(%{count: count}) when is_integer(count) and count > 0,
    do:
      "bg-green-950/30 border border-green-500/50 rounded-lg p-2.5 text-center min-w-0 text-green-300"

  defp luna_stage_class(_),
    do: "bg-gray-900/70 border border-gray-700 rounded-lg p-2.5 text-center min-w-0 text-gray-500"

  # ── Phase C: 영역 5 헬퍼 ───────────────────────────────────────

  defp load_cross_pipelines do
    sql = """
    SELECT event_type, COUNT(*) AS cnt, MAX(created_at) AS last_at
    FROM agent.event_lake
    WHERE event_type LIKE 'cross_pipeline.%'
      AND created_at > NOW() - INTERVAL '24 hours'
    GROUP BY event_type
    ORDER BY last_at DESC
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Enum.reduce(rows, %{}, fn [event_type, cnt, last_at], acc ->
          case parse_pipeline_event_type(event_type) do
            {key, status} ->
              existing = Map.get(acc, key, %{count: 0, last_at: nil})

              Map.put(acc, key, %{
                count: existing.count + cnt,
                last_at: pick_later(existing.last_at, last_at),
                status_counts:
                  Map.update(existing[:status_counts] || %{}, status, cnt, &(&1 + cnt))
              })

            nil ->
              acc
          end
        end)

      _ ->
        %{}
    end
  rescue
    _ -> %{}
  end

  defp parse_pipeline_event_type("cross_pipeline." <> rest) do
    case String.split(rest, ".", parts: 2) do
      [pipeline_str, status] ->
        case Map.get(@pipeline_atom_map, pipeline_str) do
          nil -> nil
          key -> {key, status}
        end

      _ ->
        nil
    end
  end

  defp parse_pipeline_event_type(_), do: nil

  defp update_pipeline_count(cross_pipelines, topic) do
    existing = Map.get(cross_pipelines, topic, %{count: 0, last_at: nil})

    Map.put(cross_pipelines, topic, %{
      count: (existing[:count] || 0) + 1,
      last_at: DateTime.utc_now(),
      status_counts: Map.update(existing[:status_counts] || %{}, "live", 1, &(&1 + 1))
    })
  end

  defp update_pipeline_from_event(cross_pipelines, event) when is_map(event) do
    event_type = event["event_type"] || event[:event_type]

    case parse_pipeline_event_type(event_type || "") do
      {key, status} ->
        ts = event_timestamp(event) || DateTime.utc_now()
        existing = Map.get(cross_pipelines, key, %{count: 0, last_at: nil, status_counts: %{}})

        Map.put(cross_pipelines, key, %{
          count: (existing[:count] || 0) + 1,
          last_at: pick_later(existing[:last_at], ts),
          status_counts: Map.update(existing[:status_counts] || %{}, status, 1, &(&1 + 1))
        })

      nil ->
        cross_pipelines
    end
  end

  defp update_pipeline_from_event(cross_pipelines, _), do: cross_pipelines

  defp pipeline_card_class(:claude_to_all),
    do:
      "bg-yellow-950/30 border border-yellow-500/50 rounded-lg p-2.5 flex items-center justify-between gap-2"

  defp pipeline_card_class(_),
    do:
      "bg-gray-900/70 border border-gray-700 rounded-lg p-2.5 flex items-center justify-between gap-2"

  defp pipeline_count_class(count) when is_integer(count) and count > 0,
    do: "text-xs font-semibold text-green-400"

  defp pipeline_count_class(_), do: "text-xs font-semibold text-gray-500"

  defp pipeline_status_summary(status_counts)
       when is_map(status_counts) and map_size(status_counts) > 0 do
    status_counts
    |> Enum.sort_by(fn {status, _count} -> to_string(status) end)
    |> Enum.map(fn {status, count} -> "#{status}:#{count}" end)
    |> Enum.join(" ")
  end

  defp pipeline_status_summary(_), do: "—"

  # ── Phase C: 영역 6 헬퍼 ───────────────────────────────────────

  defp load_team_health do
    sql = """
    SELECT team, bot_name, event_type, COUNT(*) AS cnt, MAX(created_at) AS last_at
    FROM agent.event_lake
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY team, bot_name, event_type
    """

    base =
      case Jay.Core.Repo.query(sql, []) do
        {:ok, %{rows: rows}} ->
          Enum.reduce(rows, %{}, fn [team, bot_name, event_type, cnt, last_at], acc ->
            case canonical_team_key(team, bot_name, event_type) do
              nil ->
                acc

              team_key ->
                existing = Map.get(acc, team_key, %{event_count: 0, last_at: nil})

                Map.put(acc, team_key, %{
                  event_count: (existing[:event_count] || 0) + cnt,
                  last_at: pick_later(existing[:last_at], last_at)
                })
            end
          end)

        _ ->
          %{}
      end

    update_agent_statuses(base)
  rescue
    _ -> %{}
  end

  defp update_agent_statuses(team_health) do
    andy = safe_call(fn -> Jay.Core.Agents.Andy.get_status() end, nil)
    jimmy = safe_call(fn -> Jay.Core.Agents.Jimmy.get_status() end, nil)
    ska = Map.get(team_health, "ska", %{event_count: 0, last_at: nil})

    Map.put(
      team_health,
      "ska",
      Map.merge(ska, %{
        andy_status: andy && andy.status,
        andy_last_check: andy && andy.last_check,
        jimmy_status: jimmy && jimmy.status,
        jimmy_last_check: jimmy && jimmy.last_check
      })
    )
  end

  defp update_team_last_active(team_health, event) when is_map(event) do
    team =
      canonical_team_key(
        event["team"] || event[:team],
        event["bot_name"] || event[:bot_name],
        event["event_type"] || event[:event_type]
      )

    ts = event_timestamp(event)

    if team && ts do
      existing = Map.get(team_health, team, %{event_count: 0, last_at: nil})

      Map.put(
        team_health,
        team,
        Map.merge(existing, %{
          event_count: (existing[:event_count] || 0) + 1,
          last_at: pick_later(existing[:last_at], ts)
        })
      )
    else
      team_health
    end
  end

  defp update_team_last_active(team_health, _), do: team_health

  defp canonical_team_key(team, bot_name, event_type) do
    team_text = team |> to_string() |> String.downcase()
    bot_text = bot_name |> to_string() |> String.downcase()
    event_text = event_type |> to_string() |> String.downcase()
    combined = Enum.join([team_text, bot_text, event_text], " ")

    cond do
      team_text in [
        "ska",
        "luna",
        "blog",
        "claude",
        "jay",
        "sigma",
        "darwin",
        "reservation",
        "master",
        "metty",
        "codex"
      ] ->
        team_text

      team_text == "investment" ->
        "luna"

      team_text in ["hub", "platform"] ->
        "hub"

      team_text in ["social", "social_media", "social-media"] ->
        "social-media"

      String.contains?(event_text, "master.") or String.contains?(bot_text, "master") ->
        "master"

      String.contains?(event_text, "metty.") or String.contains?(bot_text, "metty") ->
        "metty"

      String.contains?(event_text, "codex.") or String.contains?(bot_text, "codex") ->
        "codex"

      String.contains?(combined, "cross_team_router") or
          String.starts_with?(event_text, "cross_pipeline.") ->
        "jay"

      String.contains?(combined, "hub") ->
        "hub"

      String.contains?(combined, "luna") or String.contains?(combined, "investment") ->
        "luna"

      String.contains?(combined, "blog") ->
        "blog"

      String.contains?(combined, "claude") or String.contains?(combined, "dexter") ->
        "claude"

      String.contains?(combined, "ska") ->
        "ska"

      String.contains?(combined, "sigma") ->
        "sigma"

      String.contains?(combined, "darwin") ->
        "darwin"

      String.contains?(combined, "reservation") ->
        "reservation"

      String.contains?(combined, "social") ->
        "social-media"

      true ->
        nil
    end
  end

  defp team_health_status("ska", %{andy_status: :error}), do: :degraded
  defp team_health_status("ska", %{jimmy_status: :error}), do: :degraded
  defp team_health_status(_team, health), do: team_activity_status(health)

  defp team_activity_status(%{last_at: nil}), do: :unknown

  defp team_activity_status(%{last_at: last_at}) do
    diff = DateTime.diff(DateTime.utc_now(), to_utc_datetime(last_at), :second)

    cond do
      diff < 3_600 -> :active
      diff < 21_600 -> :recent
      true -> :stale
    end
  rescue
    _ -> :unknown
  end

  defp team_activity_status(_), do: :unknown

  defp team_status_class(:active), do: "text-green-400"
  defp team_status_class(:recent), do: "text-yellow-400"
  defp team_status_class(:degraded), do: "text-red-400"
  defp team_status_class(:stale), do: "text-orange-400"
  defp team_status_class(:unknown), do: "text-gray-500"

  defp team_status_label(:active), do: "● 활성"
  defp team_status_label(:recent), do: "○ 최근"
  defp team_status_label(:degraded), do: "● 저하"
  defp team_status_label(:stale), do: "○ 부진"
  defp team_status_label(:unknown), do: "— 없음"

  defp agent_status_emoji(:ok), do: "✓"
  defp agent_status_emoji(:error), do: "✗"
  defp agent_status_emoji(:idle), do: "·"
  defp agent_status_emoji(_), do: "·"

  defp format_relative_time(nil), do: "—"

  defp format_relative_time(dt) do
    diff = DateTime.diff(DateTime.utc_now(), to_utc_datetime(dt), :second)

    cond do
      diff < 60 -> "방금"
      diff < 3_600 -> "#{div(diff, 60)}분 전"
      diff < 86_400 -> "#{div(diff, 3_600)}시간 전"
      true -> "24시간 이상"
    end
  rescue
    _ -> "—"
  end

  defp pick_later(nil, b), do: b
  defp pick_later(a, nil), do: a

  defp pick_later(a, b) do
    if DateTime.compare(to_utc_datetime(a), to_utc_datetime(b)) == :gt, do: a, else: b
  rescue
    _ -> b
  end

  defp to_utc_datetime(%DateTime{} = dt), do: dt
  defp to_utc_datetime(%NaiveDateTime{} = ndt), do: DateTime.from_naive!(ndt, "Etc/UTC")

  defp to_utc_datetime(s) when is_binary(s) do
    normalized = String.replace(s, " ", "T")

    case DateTime.from_iso8601(normalized) do
      {:ok, dt, _} -> dt
      _ -> DateTime.utc_now()
    end
  end

  defp to_utc_datetime(_), do: DateTime.utc_now()

  # ── 기존 헬퍼 ────────────────────────────────────────────────────

  defp assign_initial_state(socket) do
    phase_status =
      safe_call(fn -> Jay.V2.AutonomyController.get_status() end, %{
        phase: 1,
        phase_since: nil,
        consecutive_clean_days: 0,
        master_intervention_count: 0,
        last_escalation_at: nil
      })

    growth_cycle = safe_call(fn -> load_growth_cycle_status() end, %{})

    growth_scheduler =
      safe_call(fn -> load_growth_scheduler_status() end, default_growth_scheduler())

    events = safe_call(fn -> Jay.Core.EventLake.get_recent(50) end, [])

    event_stats =
      safe_call(fn -> Jay.Core.EventLake.get_stats() end, %{total: 0, by_type: %{}, by_team: %{}})

    cycles = safe_call(fn -> load_recent_cycles() end, [])
    cross_pipelines = safe_call(fn -> load_cross_pipelines() end, %{})
    team_health = safe_call(fn -> load_team_health() end, %{})
    sigma_status = safe_call(fn -> load_sigma_status() end, %{})
    luna_pipeline = safe_call(fn -> load_luna_pipeline_seed() end, init_luna_pipeline())
    project_visibility = load_project_visibility()

    socket
    |> assign(:phase_status, phase_status)
    |> assign(:growth_cycle, growth_cycle)
    |> assign(:growth_scheduler, growth_scheduler)
    |> assign(:cycle_status, :idle)
    |> assign(:cycle_start_payload, nil)
    |> assign(:teams_collected, [])
    |> assign(:events, events)
    |> assign(:event_stats, event_stats)
    |> assign(:cycles, cycles)
    |> assign(:cross_pipelines, cross_pipelines)
    |> assign(:team_health, team_health)
    |> assign(:sigma_status, sigma_status)
    |> assign(:luna_pipeline, luna_pipeline)
    |> assign_project_visibility(project_visibility)
    |> assign(:kanban_stages, TeamJay.Dashboard.ProjectVisibility.kanban_stages())
    |> assign(:selected_project_task, nil)
    |> assign(:project_error, nil)
    |> assign(:selected_trace_id, nil)
    |> assign(:trace_detail, nil)
    |> assign(:trace_loading, false)
  end

  defp safe_call(func, default) do
    try do
      func.()
    rescue
      _ -> default
    catch
      :exit, _ -> default
    end
  end

  defp safe_subscribe(topic) do
    Jay.V2.Topics.subscribe(topic)
  rescue
    _ -> :ok
  end

  defp safe_cross_topics do
    safe_call(fn -> Jay.V2.Topics.cross_topics() end, [])
  end

  defp load_recent_cycles do
    sql = """
    SELECT metadata->>'cycle_id' AS cycle_id
    FROM agent.event_lake
    WHERE metadata->>'cycle_id' IS NOT NULL
      AND metadata->>'cycle_id' ~ '^[0-9]+$'
    GROUP BY metadata->>'cycle_id'
    ORDER BY (metadata->>'cycle_id')::int DESC
    LIMIT 5
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Enum.map(rows, fn [cycle_id] ->
          %{cycle_id: cycle_id, events: load_cycle_events(cycle_id)}
        end)

      _ ->
        []
    end
  rescue
    _ -> []
  end

  defp load_cycle_events(cycle_id) do
    sql = """
    SELECT event_type, team, bot_name, title, severity, created_at
    FROM agent.event_lake
    WHERE metadata->>'cycle_id' = $1
    ORDER BY created_at ASC
    LIMIT 30
    """

    case Jay.Core.Repo.query(sql, [to_string(cycle_id)]) do
      {:ok, %{rows: rows}} -> Enum.map(rows, &row_to_cycle_event/1)
      _ -> []
    end
  rescue
    _ -> []
  end

  defp row_to_cycle_event([event_type, team, bot_name, title, severity, created_at]) do
    %{
      event_type: event_type,
      team: team,
      bot_name: bot_name,
      title: title,
      severity: severity,
      created_at: created_at
    }
  end

  defp refresh_phase_status(socket) do
    status =
      safe_call(fn -> Jay.V2.AutonomyController.get_status() end, socket.assigns.phase_status)

    assign(socket, phase_status: status)
  end

  defp format_date(nil), do: "—"
  defp format_date(%Date{} = d), do: Date.to_string(d)
  defp format_date(s) when is_binary(s), do: s
  defp format_date(_), do: "—"

  # cycle #61 B+C: phase_since로부터 며칠 지났는지 계산
  defp days_since_phase_start(nil), do: 0

  defp days_since_phase_start(%Date{} = since) do
    Date.diff(kst_today(), since)
    |> max(0)
  end

  defp days_since_phase_start(s) when is_binary(s) do
    case Date.from_iso8601(s) do
      {:ok, d} -> days_since_phase_start(d)
      _ -> 0
    end
  end

  defp days_since_phase_start(_), do: 0

  # cycle #62 A: 영역 10 task started_at으로부터 며칠 지났는지 (시드 간극 가시화)
  defp days_since_started(nil), do: 0

  defp days_since_started(%DateTime{} = dt) do
    DateTime.diff(DateTime.utc_now(), dt, :day) |> max(0)
  end

  defp days_since_started(_), do: 0

  defp kst_today do
    DateTime.utc_now()
    |> DateTime.add(@kst_offset_seconds, :second)
    |> DateTime.to_date()
  end

  defp task_stale_class(started_at) do
    days = days_since_started(started_at)

    cond do
      days >= 7 -> "text-yellow-500/80"
      days >= 3 -> "text-gray-400"
      true -> "text-gray-600"
    end
  end

  defp format_datetime(nil), do: "—"

  defp format_datetime(%DateTime{} = dt) do
    dt |> DateTime.add(@kst_offset_seconds, :second) |> DateTime.to_naive() |> format_kst_label()
  rescue
    _ -> "—"
  end

  defp format_datetime(s) when is_binary(s) do
    case parse_event_time(s) do
      nil -> String.slice(s, 0, 16)
      parsed -> format_event_time(parsed)
    end
  end

  defp format_datetime(_), do: "—"

  defp format_event_time(nil), do: "—"
  defp format_event_time(%NaiveDateTime{} = dt), do: format_kst_label(dt)

  defp format_event_time(%DateTime{} = dt) do
    dt |> DateTime.add(@kst_offset_seconds, :second) |> DateTime.to_naive() |> format_kst_label()
  rescue
    _ -> "—"
  end

  defp format_event_time(s) when is_binary(s) do
    s
    |> parse_event_time()
    |> case do
      nil -> String.slice(s, 0, 16)
      parsed -> format_event_time(parsed)
    end
  end

  defp format_event_time(_), do: "—"

  defp event_timestamp(event) when is_map(event) do
    Enum.find_value(
      [
        :created_at,
        "created_at",
        :inserted_at,
        "inserted_at",
        :event_at,
        "event_at",
        :occurred_at,
        "occurred_at",
        :timestamp,
        "timestamp",
        :received_at,
        "received_at"
      ],
      &Map.get(event, &1)
    )
  end

  defp event_timestamp(_), do: nil

  defp event_trace_id(event) when is_map(event) do
    trace_id =
      Enum.find_value([:trace_id, "trace_id"], fn key ->
        case Map.get(event, key) do
          value when is_binary(value) and value != "" -> value
          _ -> nil
        end
      end)

    if valid_trace_id?(trace_id), do: trace_id
  end

  defp event_trace_id(_), do: nil

  defp langfuse_trace_url(trace_id) do
    host =
      :team_jay
      |> Application.get_env(:langfuse, [])
      |> Keyword.get(:host)
      |> Kernel.||(System.get_env("LANGFUSE_HOST"))
      |> Kernel.||("http://localhost:3000")
      |> String.trim_trailing("/")

    project_id =
      :team_jay
      |> Application.get_env(:langfuse, [])
      |> Keyword.get(:project_id)
      |> Kernel.||(System.get_env("LANGFUSE_PROJECT_ID"))
      |> Kernel.||("team-jay-prod")

    "#{host}/project/#{URI.encode_www_form(to_string(project_id))}/traces/#{URI.encode_www_form(to_string(trace_id))}"
  end

  defp short_trace_id(trace_id) when is_binary(trace_id), do: String.slice(trace_id, 0, 8)
  defp short_trace_id(trace_id), do: trace_id |> to_string() |> String.slice(0, 8)

  defp valid_trace_id?(trace_id) when is_binary(trace_id) do
    trace_id != "" and trace_id != "00000000000000000000000000000000"
  end

  defp valid_trace_id?(_), do: false

  defp format_kst_label(%NaiveDateTime{} = dt) do
    date = NaiveDateTime.to_date(dt)
    time = Calendar.strftime(dt, "%H:%M")
    "#{date.year}.#{pad2(date.month)}.#{pad2(date.day)} #{time}"
  end

  defp parse_event_time(value) do
    normalized = String.replace(value, " ", "T")

    with {:error, _} <- DateTime.from_iso8601(normalized),
         {:error, _} <- NaiveDateTime.from_iso8601(normalized) do
      nil
    else
      {:ok, %DateTime{} = dt, _offset} -> dt
      {:ok, %NaiveDateTime{} = dt} -> dt
    end
  rescue
    _ -> nil
  end

  defp pad2(value) when is_integer(value) and value < 10, do: "0#{value}"
  defp pad2(value), do: to_string(value)

  defp progress_color(1), do: "bg-red-500"
  defp progress_color(2), do: "bg-yellow-500"
  defp progress_color(3), do: "bg-green-500"
  defp progress_color(_), do: "bg-gray-500"

  defp cycle_status_badge(:running), do: "bg-yellow-500/20 text-yellow-400"
  defp cycle_status_badge(:completed), do: "bg-green-500/20 text-green-400"
  defp cycle_status_badge(_), do: "bg-gray-700 text-gray-400"

  defp cycle_status_label(:running), do: "▶ 실행 중"
  defp cycle_status_label(:completed), do: "✓ 완료"
  defp cycle_status_label(_), do: "— 대기"

  defp severity_class("error"), do: "severity-error"
  defp severity_class("warn"), do: "severity-warn"
  defp severity_class("warning"), do: "severity-warn"
  defp severity_class(_), do: "severity-info"

  defp bot_emoji("master"), do: "🧑"
  defp bot_emoji("metty"), do: "🧠"
  defp bot_emoji("codex"), do: "⌨"
  defp bot_emoji(_), do: "•"

  defp collab_event_label("master.intervention.telegram"), do: "마스터 텔레그램 개입"
  defp collab_event_label("master.intervention.phase_change"), do: "마스터 Phase 변경"
  defp collab_event_label("master.intervention.decision"), do: "마스터 결정"
  defp collab_event_label("metty.session.started"), do: "메티 세션 시작"
  defp collab_event_label("metty.session.analyzed"), do: "메티 분석"
  defp collab_event_label("metty.session.designed"), do: "메티 설계"
  defp collab_event_label("metty.session.handoff_updated"), do: "메티 인수인계 갱신"
  defp collab_event_label("metty.session.lesson_added"), do: "메티 레슨 추가"
  defp collab_event_label("codex.task.started"), do: "코덱스 작업 시작"
  defp collab_event_label("codex.task.checkbox_updated"), do: "코덱스 체크박스 갱신"
  defp collab_event_label("codex.task.archived"), do: "코덱스 작업 아카이브"
  defp collab_event_label(event_type), do: event_type || "협업 이벤트"

  defp steps_completed(team_count, cycle_status) do
    active_idx =
      case cycle_status do
        :idle -> -1
        :completed -> 6
        :running -> min(team_count, 5)
      end

    @cycle_steps
    |> Enum.with_index()
    |> Enum.map(fn {name, i} ->
      %{
        name: name,
        active: cycle_status == :completed or (cycle_status == :running and i <= active_idx)
      }
    end)
  end

  defp step_color(true), do: "bg-green-500/20 text-green-300 border border-green-500/40"
  defp step_color(false), do: "bg-gray-700 text-gray-500 border border-gray-600"

  defp top_n(map, n) do
    map
    |> Enum.sort_by(fn {_k, v} -> -v end)
    |> Enum.take(n)
  end

  defp next_cycle_label(%{schedule: %{hour: hour, minute: minute}})
       when is_integer(hour) and is_integer(minute) do
    kst_now = DateTime.utc_now() |> DateTime.add(9 * 60 * 60, :second)
    today_target = %{kst_now | hour: hour, minute: minute, second: 0, microsecond: {0, 0}}
    time_label = "#{pad2(hour)}:#{pad2(minute)} KST"

    if DateTime.compare(kst_now, today_target) == :gt do
      "내일 #{time_label}"
    else
      diff_secs = DateTime.diff(today_target, kst_now)
      hours = div(diff_secs, 3600)
      mins = div(rem(diff_secs, 3600), 60)
      "오늘 #{time_label} (#{hours}시간 #{mins}분 후)"
    end
  end

  defp next_cycle_label(_), do: "스케줄 미확인"
end
