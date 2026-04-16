defmodule TeamJay.Ska.FailureTracker do
  @moduledoc """
  스카팀 자기 복구 Loop 1:
    실패 감지 → 분류 → DB 축적 → 자동 복구 시도 → 학습

  에러 유형:
    :network_error   — ECONNREFUSED, ERR_NETWORK 등
    :selector_broken — detached Frame, selector not found 등
    :timeout         — TimeoutError, Navigation timeout 등
    :auth_expired    — 401, session expired, 로그인 필요 등
    :unknown         — 미분류

  자동 복구 전략:
    network_error  → 지수 백오프 재시도 (최대 3회)
    selector_broken → ParsingGuard에 폴백 요청
    timeout        → 타임아웃 값 증가 + 재시도
    auth_expired   → 세션 재생성 요청
    unknown        → DB 등록 + 텔레그램 알림

  Phase별 알림:
    Phase 1: 모든 복구 시도를 텔레그램 알림
    Phase 2: 실패 복구만 알림 (성공은 로그만)
    Phase 3: 로그만 (주간 리포트)
  """

  use GenServer
  require Logger

  @auto_resolve_threshold 3
  @escalate_threshold 5
  @db_poll_interval_ms 60_000  # 60초마다 DB 폴링 (Node.js 에이전트 실패 수집)

  defstruct [
    :phase,
    :stats,
    :recovery_memory
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "실패 보고 (에이전트에서 호출)"
  def report(failure) when is_map(failure) do
    GenServer.cast(__MODULE__, {:report_failure, failure})
  end

  @doc "최근 실패 목록 조회"
  def get_recent(limit \\ 20) do
    GenServer.call(__MODULE__, {:get_recent, limit})
  end

  @doc "통계 조회 (파싱 성공률, 복구율 등)"
  def get_stats do
    GenServer.call(__MODULE__, :get_stats)
  end

  @doc "현재 자율 운영 Phase (1/2/3) 조회"
  def get_phase do
    GenServer.call(__MODULE__, :get_phase)
  end

  @doc "Phase 전환 (Orchestrator가 호출)"
  def set_phase(phase) when phase in [1, 2, 3] do
    GenServer.cast(__MODULE__, {:set_phase, phase})
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[FailureTracker] 시작! Phase 1 (감시 모드)")
    # 60초 후 첫 DB 폴링 시작 (Node.js 에이전트 실패 수집)
    Process.send_after(self(), :poll_db, @db_poll_interval_ms)
    state = %__MODULE__{
      phase: 1,
      stats: %{
        total_failures: 0,
        auto_resolved: 0,
        unresolved: 0,
        by_type: %{}
      },
      recovery_memory: %{}
    }
    {:ok, state}
  end

  @impl true
  def handle_cast({:report_failure, failure}, state) do
    classified = classify_failure(failure)
    agent = Map.get(failure, :agent, "unknown")
    message = Map.get(failure, :message, "")

    Logger.warning("[FailureTracker] #{agent} / #{classified}: #{String.slice(message, 0, 100)}")

    # DB에 실패 케이스 축적 (비동기)
    Task.start(fn -> upsert_failure_case(classified, message, agent) end)

    # 현재 카운트 확인 (메모리 캐시)
    key = {agent, classified}
    count = Map.get(state.recovery_memory, key, 0) + 1
    new_memory = Map.put(state.recovery_memory, key, count)

    new_state = %{state |
      stats: update_stats(state.stats, classified),
      recovery_memory: new_memory
    }

    # 임계치 도달 시 자동 복구 시도
    cond do
      count >= @escalate_threshold ->
        attempt_escalate(classified, agent, failure, state.phase)
        {:noreply, new_state}

      count >= @auto_resolve_threshold ->
        attempt_auto_resolve(classified, agent, failure, state.phase)
        {:noreply, new_state}

      true ->
        maybe_notify(classified, agent, failure, state.phase)
        {:noreply, new_state}
    end
  end

  @impl true
  def handle_cast({:set_phase, phase}, state) do
    Logger.info("[FailureTracker] Phase #{state.phase} → Phase #{phase} 전환!")
    TeamJay.Ska.PubSub.broadcast_phase_changed(state.phase, phase)
    {:noreply, %{state | phase: phase}}
  end

  @impl true
  def handle_info(:poll_db, state) do
    Process.send_after(self(), :poll_db, @db_poll_interval_ms)
    new_state = poll_and_resolve(state)
    {:noreply, new_state}
  end

  @impl true
  def handle_call({:get_recent, limit}, _from, state) do
    rows = fetch_recent_failures(limit)
    {:reply, rows, state}
  end

  @impl true
  def handle_call(:get_stats, _from, state) do
    {:reply, state.stats, state}
  end

  @impl true
  def handle_call(:get_phase, _from, state) do
    {:reply, state.phase, state}
  end

  # ─── Private: 실패 분류 ───────────────────────────────────

  defp classify_failure(%{error_type: type}) when is_atom(type), do: type
  defp classify_failure(%{error_type: type}) when is_binary(type) do
    type |> String.to_existing_atom()
  rescue
    _ -> :unknown
  end

  defp classify_failure(%{message: msg}) when is_binary(msg) do
    cond do
      String.contains?(msg, ["detached Frame", "selector", "not found", "No node found"]) ->
        :selector_broken

      String.contains?(msg, ["ECONNREFUSED", "ECONNRESET", "ERR_NETWORK", "fetch failed"]) ->
        :network_error

      String.contains?(msg, ["timeout", "Timeout", "TimeoutError", "Navigation timeout"]) ->
        :timeout

      String.contains?(msg, ["401", "Unauthorized", "session expired", "로그인", "login"]) ->
        :auth_expired

      true ->
        :unknown
    end
  end

  defp classify_failure(_), do: :unknown

  # ─── Private: 자동 복구 전략 ─────────────────────────────

  defp attempt_auto_resolve(:network_error, agent, _failure, phase) do
    Logger.info("[FailureTracker] #{agent}: network_error → 재시도 예약")
    notify_if_needed(phase, :info,
      "🔄 #{agent} network_error 자동 복구 시도 (지수 백오프)")
    TeamJay.Ska.PubSub.broadcast(:failure_reported, %{
      agent: agent,
      error_type: :network_error,
      action: :retry_backoff
    })
  end

  defp attempt_auto_resolve(:selector_broken, agent, failure, phase) do
    Logger.warning("[FailureTracker] #{agent}: selector_broken → ParsingGuard 폴백 요청")
    target = Map.get(failure, :target, agent)
    notify_if_needed(phase, :warning,
      "🔧 #{agent} selector_broken → ParsingGuard Level 2/3 폴백")
    TeamJay.Ska.PubSub.broadcast(:failure_reported, %{
      agent: agent,
      error_type: :selector_broken,
      target: target,
      action: :parsing_fallback
    })
  end

  defp attempt_auto_resolve(:timeout, agent, _failure, phase) do
    Logger.info("[FailureTracker] #{agent}: timeout → 타임아웃 증가 재시도")
    notify_if_needed(phase, :info,
      "⏱️ #{agent} timeout → 타임아웃 2배 증가 재시도")
  end

  defp attempt_auto_resolve(:auth_expired, agent, _failure, phase) do
    Logger.warning("[FailureTracker] #{agent}: auth_expired → 세션 재생성 요청")
    notify_if_needed(phase, :warning,
      "🔑 #{agent} 세션 만료 → 자동 재로그인 시도")
    TeamJay.Ska.PubSub.broadcast(:failure_reported, %{
      agent: agent,
      error_type: :auth_expired,
      action: :session_refresh
    })
  end

  defp attempt_auto_resolve(:unknown, agent, failure, phase) do
    Logger.error("[FailureTracker] #{agent}: unknown error (count >= #{@auto_resolve_threshold})")
    notify_if_needed(phase, :error,
      "❓ #{agent} 미분류 에러 #{@auto_resolve_threshold}회+ → 케이스 등록됨")
    TeamJay.EventLake.record(%{
      event_type: "ska_unknown_failure",
      team: "ska",
      bot_name: agent,
      severity: "warning",
      title: "미분류 에러 반복",
      message: inspect(failure),
      tags: ["failure_tracker", "unknown", "phase#{phase}"]
    })
  end

  # ─── Private: 에스컬레이션 (5회+ 반복 시) ─────────────────

  defp attempt_escalate(error_type, agent, failure, _phase) do
    Logger.error("[FailureTracker] 🚨 에스컬레이션: #{agent} / #{error_type} #{@escalate_threshold}회+")
    TeamJay.HubClient.post_alarm(
      "🚨 스카팀 에스컬레이션!\n에이전트: #{agent}\n에러유형: #{error_type}\n반복횟수: #{@escalate_threshold}+\n→ 코덱스 수정 요청 등록",
      "ska",
      "failure_tracker"
    )
    TeamJay.EventLake.record(%{
      event_type: "ska_failure_escalated",
      team: "ska",
      bot_name: agent,
      severity: "critical",
      title: "실패 에스컬레이션: #{error_type}",
      message: inspect(failure),
      tags: ["failure_tracker", "escalate", to_string(error_type)]
    })
  end

  # ─── Private: Phase별 알림 ────────────────────────────────

  defp notify_if_needed(1, _level, msg) do
    # Phase 1: 모든 복구 시도 알림
    TeamJay.HubClient.post_alarm(msg, "ska", "failure_tracker")
  end

  defp notify_if_needed(2, :error, msg) do
    # Phase 2: 실패 복구만 알림
    TeamJay.HubClient.post_alarm(msg, "ska", "failure_tracker")
  end

  defp notify_if_needed(2, :warning, msg) do
    TeamJay.HubClient.post_alarm(msg, "ska", "failure_tracker")
  end

  defp notify_if_needed(2, :info, _msg), do: :ok

  defp notify_if_needed(3, _level, _msg) do
    # Phase 3: 로그만 (주간 리포트)
    :ok
  end

  defp notify_if_needed(_phase, _level, _msg), do: :ok

  defp maybe_notify(:unknown, agent, failure, phase) do
    notify_if_needed(phase, :warning,
      "❓ #{agent} 미분류 에러: #{String.slice(inspect(failure), 0, 80)}")
  end

  defp maybe_notify(_type, _agent, _failure, _phase), do: :ok

  # ─── Private: DB 폴링 (Node.js 에이전트 실패 수집) ──────────

  defp poll_and_resolve(state) do
    # Node.js가 직접 기록한 미처리 케이스 조회
    sql = """
    SELECT id, error_type, error_message, agent, count
    FROM ska.failure_cases
    WHERE auto_resolved = FALSE
      AND count >= $1
    ORDER BY last_seen DESC
    LIMIT 50
    """
    case TeamJay.Repo.query(sql, [@auto_resolve_threshold]) do
      {:ok, %{rows: rows}} ->
        Enum.reduce(rows, state, fn [id, type_str, message, agent, count], acc ->
          error_type = String.to_existing_atom(type_str)
          failure = %{agent: agent, error_type: error_type, message: message, id: id}

          # 메모리 카운터 동기화
          key = {agent, error_type}
          new_memory = Map.put(acc.recovery_memory, key, count)

          if count >= @escalate_threshold do
            attempt_escalate(error_type, agent, failure, acc.phase)
          else
            attempt_auto_resolve(error_type, agent, failure, acc.phase)
          end

          %{acc | recovery_memory: new_memory}
        end)

      {:error, err} ->
        Logger.error("[FailureTracker] DB 폴링 실패: #{inspect(err)}")
        state
    end
  rescue
    e ->
      Logger.error("[FailureTracker] poll_and_resolve 예외: #{inspect(e)}")
      state
  end

  # ─── Private: DB 연동 ─────────────────────────────────────

  defp upsert_failure_case(error_type, message, agent) do
    sql = """
    INSERT INTO ska.failure_cases
      (error_type, error_message, agent, count, first_seen, last_seen)
    VALUES ($1, $2, $3, 1, NOW(), NOW())
    ON CONFLICT (agent, error_type, md5(error_message))
    DO UPDATE SET
      count    = ska.failure_cases.count + 1,
      last_seen = NOW()
    """
    case TeamJay.Repo.query(sql, [to_string(error_type), message, agent]) do
      {:ok, _} -> :ok
      {:error, err} ->
        Logger.error("[FailureTracker] DB upsert 실패: #{inspect(err)}")
    end
  end

  defp fetch_recent_failures(limit) do
    sql = """
    SELECT id, error_type, error_message, agent, count,
           first_seen, last_seen, auto_resolved, resolution
    FROM ska.failure_cases
    ORDER BY last_seen DESC
    LIMIT $1
    """
    case TeamJay.Repo.query(sql, [limit]) do
      {:ok, %{rows: rows, columns: cols}} ->
        keys = Enum.map(cols, &String.to_atom/1)
        Enum.map(rows, fn row -> Enum.zip(keys, row) |> Map.new() end)
      {:error, _} -> []
    end
  end

  defp update_stats(stats, error_type) do
    by_type = Map.update(stats.by_type, error_type, 1, &(&1 + 1))
    %{stats |
      total_failures: stats.total_failures + 1,
      by_type: by_type
    }
  end
end
