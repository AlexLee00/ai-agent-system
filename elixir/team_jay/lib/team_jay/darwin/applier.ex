defmodule TeamJay.Darwin.Applier do
  @moduledoc """
  다윈팀 어플라이어 — 검증된 연구 결과를 다른 팀에 자동 적용

  verification_passed 이벤트 수신 → 자율 레벨 확인 → 적용 실행

  자율 레벨별 동작:
  - L3: 마스터 승인 요청 (텔레그램 알림만)
  - L4+: 자동 적용 (applicator.ts PortAgent 실행 + EventLake 기록)

  적용 흐름:
  1. verification_passed 수신
  2. 영향 팀 식별 (논문 태그 기반)
  3. L4+: applicator.ts 자동 실행 → EventLake darwin.applied.{team} 기록
  4. 7일 모니터링 등록 (클로드팀 DeploymentMonitor 연동)
  """

  use GenServer
  require Logger

  alias TeamJay.Darwin.{TeamLead, Topics}
  alias TeamJay.Claude.Monitor.DeploymentMonitor
  alias TeamJay.Agents.PortAgent
  alias TeamJay.HubClient
  alias TeamJay.EventLake

  @team_map %{
    "investment"  => [:luna, "투자 전략"],
    "blog"        => [:blog, "블로그 콘텐츠"],
    "system"      => [:claude, "시스템 모니터링"],
    "parsing"     => [:ska, "웹 파싱"],
    "orchestration" => [:jay, "오케스트레이션"]
  }

  defstruct [applied_count: 0, last_applied_at: nil]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def apply_now(paper) do
    GenServer.cast(__MODULE__, {:apply_now, paper})
  end

  @impl true
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    Logger.info("[DarwinApplier] 어플라이어 시작!")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:subscribe_events, state) do
    Registry.register(TeamJay.JayBus, Topics.verification_passed(), [])
    {:noreply, state}
  end

  def handle_info({:jay_event, topic, payload}, state)
      when topic == "darwin.verification.passed" do
    paper = payload[:paper] || payload
    {:noreply, handle_apply(paper, state)}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_cast({:apply_now, paper}, state) do
    {:noreply, handle_apply(paper, state)}
  end

  # ── 내부 ───────────────────────────────────────────────────────────

  defp handle_apply(paper, state) do
    level = TeamLead.get_autonomy_level()
    title = paper["title"] || paper[:title] || "unknown"
    target_teams = identify_target_teams(paper)

    if level >= 4 do
      Logger.info("[DarwinApplier] L#{level}: 자동 적용! #{title} → #{inspect(target_teams)}")
      do_auto_apply(paper, target_teams)
      %{state | applied_count: state.applied_count + 1, last_applied_at: DateTime.utc_now()}
    else
      Logger.info("[DarwinApplier] L#{level}: 마스터 승인 필요 (#{title})")
      request_master_approval(paper, target_teams)
      state
    end
  end

  defp do_auto_apply(paper, target_teams) do
    # applicator.ts 실행
    PortAgent.run(:darwin_applier)

    # EventLake에 적용 이벤트 기록 + 클로드팀 모니터링 등록
    Enum.each(target_teams, fn team ->
      record_application(paper, team)
      register_monitoring(paper, team)
    end)

    # 성공 보고
    TeamLead.pipeline_success()
    HubClient.post_alarm(
      "🔬 다윈팀 연구 적용!\n논문: #{paper["title"] || "unknown"}\n대상 팀: #{Enum.join(target_teams, ", ")}\n자율 레벨: L#{TeamLead.get_autonomy_level()}",
      "darwin-applied", "darwin"
    )
  end

  defp record_application(paper, team) do
    EventLake.record(%{
      event_type: "darwin_applied",
      team: "darwin",
      bot_name: "darwin-applier",
      title: "연구 적용: #{paper["title"] || "unknown"}",
      message: "대상 팀: #{team}",
      tags: ["darwin", "research", "applied", "team:#{team}"],
      severity: "info"
    })

    broadcast(Topics.applied(to_string(team)), %{paper: paper, team: team})
  end

  defp register_monitoring(paper, team) do
    codex_name = "darwin_apply_#{team}_#{System.unique_integer([:positive])}"
    DeploymentMonitor.register(codex_name, %{
      type: "darwin_research",
      paper_title: paper["title"] || "unknown",
      target_team: team,
      deployed_at: DateTime.utc_now()
    })
  end

  defp request_master_approval(paper, target_teams) do
    msg = """
    🔬 다윈팀 연구 적용 승인 필요!
    논문: #{paper["title"] || "unknown"}
    적합성: #{paper["score"] || "?"}점
    대상 팀: #{Enum.join(target_teams, ", ")}
    → Commander: codex_approve 또는 codex_reject
    """
    HubClient.post_alarm(msg, "darwin-approval", "darwin")
  end

  defp identify_target_teams(paper) do
    tags = paper["tags"] || paper[:tags] || []
    title = String.downcase(paper["title"] || paper[:title] || "")

    @team_map
    |> Enum.filter(fn {keyword, _} ->
      Enum.any?(tags, &String.contains?(to_string(&1), keyword)) or
      String.contains?(title, keyword)
    end)
    |> Enum.map(fn {_, [team, _]} -> team end)
    |> case do
      [] -> [:claude]  # 기본: 클로드팀
      teams -> teams
    end
  end

  defp broadcast(topic, payload) do
    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)
  end
end
