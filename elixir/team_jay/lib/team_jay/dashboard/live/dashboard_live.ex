defmodule TeamJay.Dashboard.Live.DashboardLive do
  use Phoenix.LiveView, layout: {TeamJay.Dashboard.Layouts, :app}
  require Logger

  @pubsub TeamJay.PubSub

  @kst_offset_seconds 9 * 60 * 60
  @phase_labels %{1 => {"🔴", "감시"}, 2 => {"🟡", "반자율"}, 3 => {"🟢", "자율"}}
  @phase_thresholds %{1 => 7, 2 => 30}
  @cycle_steps ~w(SENSE ANALYZE DECIDE ACT MEASURE LEARN)

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
    end

    {:ok, assign_initial_state(socket)}
  end

  # ── PubSub/JayBus 핸들러 ─────────────────────────────────────────

  @impl true
  def handle_info({:event_lake_new, event}, socket) do
    events = [event | Enum.take(socket.assigns.events, 49)]
    stats = safe_call(fn -> Jay.Core.EventLake.get_stats() end, socket.assigns.event_stats)
    {:noreply, assign(socket, events: events, event_stats: stats)}
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

  def handle_info(_msg, socket), do: {:noreply, socket}

  # ── Render ───────────────────────────────────────────────────────

  @impl true
  def render(assigns) do
    ~H"""
    <div class="min-h-screen p-4 space-y-4">
      <header class="flex items-center justify-between border-b border-gray-700 pb-3">
        <h1 class="text-xl font-bold text-white">🤖 팀 제이 대시보드</h1>
        <span class="text-xs text-gray-400">Phase A • 영역 1+3+4</span>
      </header>

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

  # ── 헬퍼 ────────────────────────────────────────────────────────

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

    socket
    |> assign(:phase_status, phase_status)
    |> assign(:growth_cycle, growth_cycle)
    |> assign(:cycle_status, :idle)
    |> assign(:cycle_start_payload, nil)
    |> assign(:teams_collected, [])
    |> assign(:events, events)
    |> assign(:event_stats, event_stats)
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
