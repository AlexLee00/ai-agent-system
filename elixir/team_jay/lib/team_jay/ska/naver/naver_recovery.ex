defmodule TeamJay.Ska.Naver.NaverRecovery do
  @moduledoc """
  네이버 전용 복구 전략 GenServer

  Phase 1 역할:
    - FailureTracker의 복구 요청 수신 (PubSub)
    - 네이버 특화 복구 전략 실행:
        :auth_expired   → NaverSession 재로그인 트리거
        :selector_broken → ParsingGuard Level 2/3 폴백
        :network_error  → 지수 백오프 재시도 예약
        :timeout        → 페이지 재로드 요청
    - 복구 결과 → FailureTracker 피드백

  FailureTracker가 복구 전략을 결정하면,
  이 모듈이 네이버 특화 실행을 담당합니다.
  """

  use GenServer
  require Logger

  @backoff_base_ms 5_000
  @backoff_max_ms 60_000
  @backoff_max_retries 3

  defstruct [
    :recovery_state,
    :backoff_registry
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "복구 상태 조회"
  def get_recovery_state do
    GenServer.call(__MODULE__, :get_recovery_state)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[NaverRecovery] 시작! 네이버 복구 전략 준비")
    TeamJay.Ska.PubSub.subscribe(:failure_reported)

    {:ok, %__MODULE__{
      recovery_state: %{},
      backoff_registry: %{}
    }}
  end

  @impl true
  def handle_info({:ska_event, :failure_reported, payload}, state) do
    agent = Map.get(payload, :agent, "")
    error_type = Map.get(payload, :error_type)
    action = Map.get(payload, :action)

    new_state =
      if agent == "andy" do
        handle_recovery_request(error_type, action, payload, state)
      else
        state
      end

    {:noreply, new_state}
  end

  @impl true
  def handle_info({:retry_after_backoff, error_type, attempt}, state) do
    Logger.info("[NaverRecovery] 백오프 재시도: #{error_type} (#{attempt}회)")
    TeamJay.Ska.PubSub.broadcast(:retry_requested, %{
      agent: "andy",
      error_type: error_type,
      attempt: attempt
    })
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_recovery_state, _from, state) do
    {:reply, state.recovery_state, state}
  end

  # ─── Private: 복구 전략 ───────────────────────────────────

  defp handle_recovery_request(:auth_expired, :session_refresh, _payload, state) do
    Logger.info("[NaverRecovery] auth_expired → NaverSession 재로그인 요청")
    TeamJay.Ska.Naver.NaverSession.report_auth_expired()
    update_recovery_state(state, :auth_expired, :refreshing)
  end

  defp handle_recovery_request(:network_error, :retry_backoff, payload, state) do
    attempt = Map.get(payload, :attempt, 1)
    delay = min(@backoff_base_ms * :math.pow(2, attempt - 1) |> round(), @backoff_max_ms)

    if attempt <= @backoff_max_retries do
      Logger.info("[NaverRecovery] network_error → #{delay}ms 후 재시도 (#{attempt}/#{@backoff_max_retries})")
      Process.send_after(self(), {:retry_after_backoff, :network_error, attempt + 1}, delay)
      update_recovery_state(state, :network_error, {:retrying, attempt})
    else
      Logger.error("[NaverRecovery] network_error 최대 재시도 초과")
      Jay.Core.HubClient.post_alarm(
        "⚠️ 앤디 네트워크 오류 #{@backoff_max_retries}회 재시도 실패",
        "ska", "naver_recovery"
      )
      update_recovery_state(state, :network_error, :failed)
    end
  end

  defp handle_recovery_request(:selector_broken, :parsing_fallback, payload, state) do
    target = Map.get(payload, :target, "naver_list")
    Logger.info("[NaverRecovery] selector_broken → ParsingGuard 폴백 요청 (#{target})")
    # ParsingGuard는 자체적으로 폴백 처리 — 캐시 무효화만 요청
    TeamJay.Ska.SelectorManager.invalidate_cache(target)
    update_recovery_state(state, :selector_broken, :fallback_requested)
  end

  defp handle_recovery_request(:timeout, _action, _payload, state) do
    Logger.info("[NaverRecovery] timeout → 페이지 재로드 요청")
    TeamJay.Ska.PubSub.broadcast(:reload_requested, %{agent: "andy", reason: :timeout})
    update_recovery_state(state, :timeout, :reload_requested)
  end

  defp handle_recovery_request(_type, _action, _payload, state), do: state

  defp update_recovery_state(state, error_type, new_status) do
    %{state | recovery_state: Map.put(state.recovery_state, error_type, %{
      status: new_status,
      updated_at: DateTime.utc_now()
    })}
  end
end
