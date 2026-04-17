defmodule TeamJay.Claude.FeedbackLoop do
  @moduledoc """
  클로드팀 피드백 루프 — 타 팀 에러 → 자동 출동

  EventLake 구독 → 타 팀 에러 감지 → 덱스터/닥터 자동 출동:

  - port_agent_failed (모든 팀) → Layer 1 테스트
  - ska_error_spike → Layer 2 전체 점검
  - blog_cross_team_command_failed → Layer 1
  - ska_cross_team_command_failed → Layer 1
  - codex_approval → CodexPipeline.approve()  ← Commander 연동

  7단계 자체 루프:
  에러감지(1) → 테스트(2) → 원인분석(3) → 수정생성(4)
  → 패치적용(5) → 재테스트(6) → 학습(7) → (1)
  """

  use GenServer
  require Logger

  alias TeamJay.Claude.Dexter.{TestRunner, ErrorTracker}
  alias TeamJay.Claude.Doctor.Dispatch
  alias TeamJay.Claude.Codex.CodexPipeline
  alias Jay.Core.HubClient

  # 타 팀 에러 이벤트 → 트리거 레이어 매핑
  @team_error_events %{
    "port_agent_failed"                  => {1, "PortAgent 스크립트 실패"},
    "system_error"                       => {1, "시스템 에러"},
    "ska_error_spike"                    => {2, "스카팀 에러 스파이크"},
    "blog_cross_team_command_failed"     => {1, "블로팀 커맨드 실패"},
    "ska_cross_team_command_failed"      => {1, "스카팀 커맨드 실패"},
    "investment_error"                   => {1, "투자팀 에러"}
  }

  defstruct [
    pg_pid: nil,
    ref: nil,
    dispatch_count: 0,
    last_dispatch: nil
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @impl true
  def init(_opts) do
    db_opts = Jay.Core.Config.notification_db_opts()
    channel = Jay.Core.Config.pg_notify_channel()

    {:ok, pid} = Postgrex.Notifications.start_link(db_opts)
    {:ok, ref} = Postgrex.Notifications.listen(pid, channel)

    Logger.info("[FeedbackLoop] 피드백 루프 시작! 타 팀 에러 모니터링 중")
    {:ok, %__MODULE__{pg_pid: pid, ref: ref}}
  end

  @impl true
  def handle_info({:notification, _pid, _ref, _channel, payload}, state) do
    case Jason.decode(payload) do
      {:ok, event} -> {:noreply, process_event(event, state)}
      _ -> {:noreply, state}
    end
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      dispatch_count: state.dispatch_count,
      last_dispatch: state.last_dispatch
    }, state}
  end

  # ── 이벤트 처리 ────────────────────────────────────────────────────

  defp process_event(%{"event_type" => "codex_approval"} = event, state) do
    codex_name = event["title"] || event["bot_name"]
    Logger.info("[FeedbackLoop] 코덱스 승인: #{codex_name}")
    CodexPipeline.approve(codex_name)
    state
  end

  defp process_event(%{"event_type" => "codex_rejection"} = event, state) do
    codex_name = event["title"] || event["bot_name"]
    Logger.info("[FeedbackLoop] 코덱스 거부: #{codex_name}")
    CodexPipeline.reject(codex_name)
    state
  end

  defp process_event(%{"event_type" => type} = event, state) do
    case Map.get(@team_error_events, type) do
      nil ->
        state

      {layer, reason} ->
        team = event["team"] || event["bot_name"] || "unknown"
        Logger.info("[FeedbackLoop] 타 팀 에러 감지: #{type} (#{team}) → Layer #{layer} 출동")

        error_entry = %{
          event_type: type,
          bot_name:   event["bot_name"] || team,
          team:       team,
          message:    event["title"] || reason,
          source:     :cross_team
        }

        # 비동기 출동
        Task.start(fn -> dispatch_response(layer, error_entry, team) end)

        %{state |
          dispatch_count: state.dispatch_count + 1,
          last_dispatch: DateTime.utc_now()
        }
    end
  end

  defp process_event(_event, state), do: state

  defp dispatch_response(1, _error_entry, team) do
    # Layer 1: 빠른 체크
    TestRunner.run_now(1)
    ErrorTracker.get_errors(1)  # 최신 에러 확인
    Logger.debug("[FeedbackLoop] Layer 1 출동 완료 (#{team})")
  end

  defp dispatch_response(2, error_entry, team) do
    # Layer 2: 전체 점검 + 닥터 출동
    TestRunner.run_now(2)
    Dispatch.dispatch(error_entry)

    # 타 팀에 알림
    HubClient.post_alarm(
      "🔧 클로드팀 출동!\n팀: #{team}\n에러: #{error_entry.message}\n→ Layer 2 점검 + 닥터 분석 중",
      "feedback-loop", "claude"
    )
    Logger.info("[FeedbackLoop] Layer 2 출동 완료 (#{team})")
  end

  defp dispatch_response(_, _error_entry, _team) do
    TestRunner.run_now(1)
  end
end
