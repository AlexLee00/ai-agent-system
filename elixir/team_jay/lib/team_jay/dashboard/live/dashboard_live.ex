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

  # ── Mount ────────────────────────────────────────────────────────

  @impl true
  def mount(_params, _session, socket) do
    if connected?(socket) do
      Phoenix.PubSub.subscribe(@pubsub, "event_lake:new")
      Phoenix.PubSub.subscribe(@pubsub, "autonomy:phase_changed")
      Phoenix.PubSub.subscribe(@pubsub, "autonomy_phase_change")
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

      # Phase C/D: Andy/Jimmy + Sigma/Luna 30초 주기 갱신
      Process.send_after(self(), :refresh_agents, 30_000)
      Process.send_after(self(), :refresh_sigma_luna, 30_000)
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

  # Phase D: Luna 13개 토픽 실시간 카운트 갱신
  def handle_info({:jay_bus, topic, payload}, socket) do
    topic_text = topic_to_string(topic)

    if luna_topic?(topic_text) do
      stage = topic_to_stage(topic_text)

      luna_pipeline =
        update_luna_pipeline(socket.assigns.luna_pipeline, stage, topic_text, payload)

      {:noreply, assign(socket, luna_pipeline: luna_pipeline)}
    else
      {:noreply, socket}
    end
  end

  # Phase C: Andy/Jimmy 주기적 갱신
  def handle_info(:refresh_agents, socket) do
    team_health = safe_call(fn -> load_team_health() end, socket.assigns.team_health)
    Process.send_after(self(), :refresh_agents, 30_000)
    {:noreply, assign(socket, team_health: team_health)}
  end

  # Phase D: Sigma MAPE-K/Pod 상태와 Luna EventLake seed 주기 갱신
  def handle_info(:refresh_sigma_luna, socket) do
    sigma_status = safe_call(fn -> load_sigma_status() end, socket.assigns.sigma_status)

    seeded_luna_pipeline =
      merge_luna_pipeline_seed(socket.assigns.luna_pipeline, load_luna_pipeline_seed())

    Process.send_after(self(), :refresh_sigma_luna, 30_000)
    {:noreply, assign(socket, sigma_status: sigma_status, luna_pipeline: seeded_luna_pipeline)}
  end

  def handle_info(_msg, socket), do: {:noreply, socket}

  # ── Render ───────────────────────────────────────────────────────

  @impl true
  def render(assigns) do
    ~H"""
    <div class="min-h-screen p-4 space-y-4">
      <header class="flex items-center justify-between border-b border-gray-700 pb-3">
        <h1 class="text-xl font-bold text-white">🤖 팀 제이 대시보드</h1>
        <span class="text-xs text-gray-400">Phase D • 영역 1+2+3+4+5+6+7+8</span>
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
            />
          </div>

          <!-- 영역 4: EventLake 실시간 스트림 -->
          <.event_lake_board events={@events} event_stats={@event_stats} />

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
        </div>

        <!-- 영역 2: 협업 타임라인 -->
        <.collab_timeline_board cycles={@cycles} />
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
    </div>
    """
  end

  attr(:status, :map, required: true)

  defp phase_header(assigns) do
    phase = assigns.status[:phase] || 1
    {emoji, label} = Map.get(@phase_labels, phase, {"⚪", "알 수 없음"})
    assigns = assign(assigns, phase: phase, emoji: emoji, label: label)

    ~H"""
    <div class="flex items-center gap-4">
      <span class="text-6xl font-black text-white">{@phase}</span>
      <div>
        <div class="text-2xl">{@emoji} {@label}</div>
        <div class="text-xs text-gray-400 mt-1">
          Phase Since: {format_date(@status[:phase_since])}
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
        <span class="text-yellow-400 font-medium">{next_cycle_label()}</span>
      </div>
    </div>
    """
  end

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
              <th class="text-left py-1 font-medium">시간</th>
            </tr>
          </thead>
          <tbody>
            <%= for event <- @events do %>
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

  # ── 영역 2: 협업 타임라인 ───────────────────────────────────────

  attr(:cycles, :list, required: true)

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

    assigns =
      assign(assigns,
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
        <span class="text-xs text-gray-400">13 토픽 실시간</span>
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

  # ── 헬퍼 ────────────────────────────────────────────────────────

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
      risk_alive: Process.whereis(Sigma.V2.Pod.Risk) != nil
    }
  rescue
    _ ->
      %{
        mapek: %{total_cycles: 0, last_cycle_at: nil, dormant: true},
        commander_alive: false,
        trend_alive: false,
        growth_alive: false,
        risk_alive: false
      }
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
  rescue
    _ -> init_luna_pipeline()
  end

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

    growth_cycle = safe_call(fn -> Jay.V2.GrowthCycle.status() end, %{})
    events = safe_call(fn -> Jay.Core.EventLake.get_recent(50) end, [])

    event_stats =
      safe_call(fn -> Jay.Core.EventLake.get_stats() end, %{total: 0, by_type: %{}, by_team: %{}})

    cycles = safe_call(fn -> load_recent_cycles() end, [])
    cross_pipelines = safe_call(fn -> load_cross_pipelines() end, %{})
    team_health = safe_call(fn -> load_team_health() end, %{})
    sigma_status = safe_call(fn -> load_sigma_status() end, %{})
    luna_pipeline = safe_call(fn -> load_luna_pipeline_seed() end, init_luna_pipeline())

    socket
    |> assign(:phase_status, phase_status)
    |> assign(:growth_cycle, growth_cycle)
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

  defp next_cycle_label do
    # 06:30 KST = 21:30 UTC
    now = DateTime.utc_now()
    target_hour = 21
    target_min = 30
    today_target = %{now | hour: target_hour, minute: target_min, second: 0, microsecond: {0, 0}}

    if DateTime.compare(now, today_target) == :gt do
      "내일 06:30 KST"
    else
      diff_secs = DateTime.diff(today_target, now)
      hours = div(diff_secs, 3600)
      mins = div(rem(diff_secs, 3600), 60)
      "오늘 06:30 KST (#{hours}시간 #{mins}분 후)"
    end
  end
end
