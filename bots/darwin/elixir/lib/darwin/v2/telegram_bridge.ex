defmodule Darwin.V2.TelegramBridge do
  @moduledoc """
  다윈 V2 텔레그램 브리지 — 중요 이벤트를 Hub를 통해 텔레그램으로 전송.

  HubClient.post_alarm/3을 사용 (직접 Telegram API 호출 없음).

  ## 알림 트리거 이벤트
  - `autonomy_upgraded`     — 자율 레벨 L{old}→L{new} 상승
  - `verification_passed`   — 논문 검증 완료 (score >= threshold)
  - `pipeline_failure`      — 연속 실패 3회 이상
  - `budget_warning`        — LLM 예산 80% 이상 소진
  - `kill_switch_activated` — Kill Switch 활성화

  ## Public API
  - `notify(message, level)` — 직접 알림 발송 (:info | :warning | :critical)
  - `subscribe_to_events()`  — JayBus 이벤트 구독 (init 시 자동 호출)

  로그 prefix: [다윈V2 텔레그램]
  """

  use GenServer
  require Logger

  alias Jay.Core.HubClient

  @verification_score_threshold 7    # 이 점수 이상이면 검증 완료 알림
  @pipeline_failure_threshold   3    # 연속 실패 N회 이상이면 알림
  @budget_warning_pct           0.80 # 예산 80% 이상 소진 시 알림

  # JayBus 구독 토픽
  @subscribed_topics [
    "darwin.autonomy.upgraded",
    "darwin.paper.verified",
    "darwin.pipeline.failed",
    "darwin.budget.updated",
    "darwin.kill_switch.activated"
  ]

  # -------------------------------------------------------------------
  # Public API
  # -------------------------------------------------------------------

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "직접 알림 발송. level: :info | :warning | :critical"
  @spec notify(String.t(), atom()) :: :ok
  def notify(message, level \\ :info) when is_binary(message) do
    GenServer.cast(__MODULE__, {:notify, message, level})
  end

  @doc "JayBus 이벤트 구독 (init 시 자동 호출됨)."
  @spec subscribe_to_events() :: :ok
  def subscribe_to_events do
    GenServer.cast(__MODULE__, :subscribe)
  end

  # -------------------------------------------------------------------
  # GenServer callbacks
  # -------------------------------------------------------------------

  @impl GenServer
  def init(_opts) do
    Logger.info("[다윈V2 텔레그램] 텔레그램 브리지 시작")
    Process.send_after(self(), :subscribe, 3_000)
    {:ok, %{consecutive_failures: 0, last_notified_at: nil}}
  end

  @impl GenServer
  def handle_info(:subscribe, state) do
    subscribe_to_events_internal()
    {:noreply, state}
  end

  # autonomy_upgraded 이벤트
  def handle_info({:jay_event, "darwin.autonomy.upgraded", payload}, state) do
    old_level = payload[:old_level] || payload["old_level"] || "?"
    new_level = payload[:new_level] || payload["new_level"] || "?"

    message = "다윈팀 자율 레벨 L#{old_level}→L#{new_level} 상승!"
    send_telegram(message, :info)

    {:noreply, state}
  end

  # verification_passed — score threshold 이상만 알림
  def handle_info({:jay_event, "darwin.paper.verified", payload}, state) do
    score  = payload[:score]  || payload["score"]  || 0
    title  = payload[:title]  || payload["title"]  || "unknown"
    passed = payload[:passed] || payload["passed"]

    if (is_number(score) and score >= @verification_score_threshold) or passed == true do
      message = "논문 검증 완료: #{title} (점수: #{score})"
      send_telegram(message, :info)
    end

    {:noreply, state}
  end

  # pipeline_failure — 연속 실패 카운터 누적
  def handle_info({:jay_event, "darwin.pipeline.failed", payload}, state) do
    new_state = %{state | consecutive_failures: state.consecutive_failures + 1}

    if new_state.consecutive_failures >= @pipeline_failure_threshold do
      team_msg = payload[:reason] || payload["reason"] || "원인 불명"
      message  = "다윈팀 연속 실패 #{new_state.consecutive_failures}회 - 확인 필요\n원인: #{team_msg}"
      send_telegram(message, :warning)
      {:noreply, %{new_state | consecutive_failures: 0}}
    else
      {:noreply, new_state}
    end
  end

  # budget_warning
  def handle_info({:jay_event, "darwin.budget.updated", payload}, state) do
    used  = payload[:used_usd]  || payload["used_usd"]  || 0.0
    total = payload[:total_usd] || payload["total_usd"] || 1.0

    ratio = if total > 0, do: used / total, else: 0.0

    if ratio >= @budget_warning_pct do
      pct     = Float.round(ratio * 100, 1)
      message = "다윈팀 LLM 예산 #{pct}% 소진 ($#{Float.round(used, 2)}/$#{Float.round(total, 2)})"
      send_telegram(message, :warning)
    end

    {:noreply, state}
  end

  # kill_switch_activated
  def handle_info({:jay_event, "darwin.kill_switch.activated", payload}, state) do
    reason  = payload[:reason] || payload["reason"] || "알 수 없음"
    message = "다윈팀 킬 스위치 활성화\n사유: #{reason}"
    send_telegram(message, :critical)

    {:noreply, state}
  end

  # 파이프라인 성공 → 연속 실패 카운터 리셋
  def handle_info({:jay_event, "darwin.pipeline.succeeded", _payload}, state) do
    {:noreply, %{state | consecutive_failures: 0}}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_cast({:notify, message, level}, state) do
    send_telegram(message, level)
    {:noreply, %{state | last_notified_at: DateTime.utc_now()}}
  end

  def handle_cast(:subscribe, state) do
    subscribe_to_events_internal()
    {:noreply, state}
  end

  # -------------------------------------------------------------------
  # Private
  # -------------------------------------------------------------------

  defp subscribe_to_events_internal do
    Enum.each(@subscribed_topics, fn topic ->
      Registry.register(Jay.Core.JayBus, topic, [])
    end)

    # 성공 이벤트도 구독 (실패 카운터 리셋용)
    Registry.register(Jay.Core.JayBus, "darwin.pipeline.succeeded", [])

    Logger.debug("[다윈V2 텔레그램] #{length(@subscribed_topics) + 1}개 토픽 구독 완료")
  end

  defp send_telegram(message, level) do
    Logger.info("[다윈V2 텔레그램] [#{level}] #{String.slice(message, 0, 80)}")

    Task.start(fn ->
      try do
        HubClient.post_alarm(message, "darwin", "darwin_#{level}")
      rescue
        e -> Logger.warning("[다윈V2 텔레그램] 발송 실패: #{Exception.message(e)}")
      end
    end)

    :ok
  end
end
