defmodule TeamJay.Ska.Naver.NaverSession do
  @moduledoc """
  네이버 세션 상태 추적 GenServer

  Phase 1 역할:
    - 세션 상태 관리 (:healthy | :expired | :refreshing | :failed)
    - auth_expired 이벤트 수신 → 재로그인 트리거
    - 세션 갱신 이력 추적
    - NaverRecovery와 협력

  세션 상태 전이:
    :unknown → :healthy (로그인 성공)
    :healthy → :expired (auth_expired 이벤트)
    :expired → :refreshing (재로그인 시도)
    :refreshing → :healthy (성공) | :failed (3회 실패)
    :failed → :healthy (수동 개입 후)
  """

  use GenServer
  require Logger

  @refresh_max_retries 3
  @session_ttl_ms 3_600_000  # 1시간마다 세션 health check

  defstruct [
    :status,
    :last_login_at,
    :refresh_attempts,
    :refresh_history,
    :session_id
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "현재 세션 상태"
  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @doc "세션 갱신 성공 보고 (PortAgent 콜백)"
  def report_login_success(session_id \\ nil) do
    GenServer.cast(__MODULE__, {:login_success, session_id})
  end

  @doc "세션 만료 보고"
  def report_auth_expired do
    GenServer.cast(__MODULE__, :auth_expired)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[NaverSession] 시작! 세션 추적 활성화")
    TeamJay.Ska.PubSub.subscribe(:failure_reported)
    # 1시간마다 세션 TTL 체크
    Process.send_after(self(), :ttl_check, @session_ttl_ms)

    {:ok, %__MODULE__{
      status: :unknown,
      last_login_at: nil,
      refresh_attempts: 0,
      refresh_history: [],
      session_id: nil
    }}
  end

  @impl true
  def handle_cast({:login_success, session_id}, state) do
    Logger.info("[NaverSession] 로그인 성공! 세션 갱신")
    entry = %{event: :login_success, at: DateTime.utc_now()}
    history = Enum.take([entry | state.refresh_history], 20)

    TeamJay.Ska.PubSub.broadcast(:session_refreshed, %{
      agent: "andy",
      session_id: session_id
    })

    {:noreply, %{state |
      status: :healthy,
      last_login_at: DateTime.utc_now(),
      refresh_attempts: 0,
      refresh_history: history,
      session_id: session_id
    }}
  end

  @impl true
  def handle_cast(:auth_expired, state) do
    Logger.warning("[NaverSession] auth_expired 감지!")
    new_attempts = state.refresh_attempts + 1

    if new_attempts > @refresh_max_retries do
      Logger.error("[NaverSession] 재로그인 #{@refresh_max_retries}회 초과 → :failed")
      Jay.Core.HubClient.post_alarm(
        "🔑 네이버 세션 갱신 #{@refresh_max_retries}회 실패 → 수동 확인 필요",
        "ska", "naver_session"
      )
      {:noreply, %{state | status: :failed, refresh_attempts: new_attempts}}
    else
      Logger.info("[NaverSession] 재로그인 시도 #{new_attempts}/#{@refresh_max_retries}")
      TeamJay.Ska.PubSub.broadcast(:failure_reported, %{
        agent: "andy",
        error_type: :auth_expired,
        action: :session_refresh,
        attempt: new_attempts
      })
      {:noreply, %{state | status: :refreshing, refresh_attempts: new_attempts}}
    end
  end

  @impl true
  def handle_info({:ska_event, :failure_reported, %{agent: "andy", error_type: :auth_expired}}, state) do
    GenServer.cast(self(), :auth_expired)
    {:noreply, state}
  end

  @impl true
  def handle_info(:ttl_check, state) do
    Process.send_after(self(), :ttl_check, @session_ttl_ms)
    case state.last_login_at do
      nil -> {:noreply, state}
      at ->
        age_ms = DateTime.diff(DateTime.utc_now(), at, :millisecond)
        if age_ms > @session_ttl_ms * 3 do
          Logger.warning("[NaverSession] 세션 TTL 초과 (#{div(age_ms, 60_000)}분)")
        end
        {:noreply, state}
    end
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      status: state.status,
      last_login_at: state.last_login_at,
      refresh_attempts: state.refresh_attempts,
      session_id: state.session_id
    }, state}
  end
end
