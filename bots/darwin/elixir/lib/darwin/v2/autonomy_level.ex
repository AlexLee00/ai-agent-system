defmodule Darwin.V2.AutonomyLevel do
  @moduledoc """
  다윈 V2 자율 레벨 관리 GenServer.

  L3 (기본, 승인 필요) → L4 (연속 5회 성공 + 7일) → L5 (완전자율, 10회 성공 + 적용 3회 + 14일)
  실패 시 L3 자동 강등. 상태는 ETS + JSON 파일 이중 영속.
  """

  use GenServer
  require Logger

  alias Jay.Core.HubClient

  @autonomy_file "bots/darwin/sandbox/darwin-autonomy-level.json"
  @table :darwin_v2_autonomy

  defstruct [
    level: 3,
    consecutive_successes: 0,
    applied_successes: 0,
    last_success_at: nil,
    level_upgraded_at: nil,
    pipeline_runs: 0
  ]

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @spec get() :: map()
  def get, do: GenServer.call(__MODULE__, :get)

  @spec level() :: 3 | 4 | 5
  def level, do: GenServer.call(__MODULE__, :level)

  @spec record_success() :: :ok
  def record_success, do: GenServer.cast(__MODULE__, :success)

  @spec record_applied_success() :: :ok
  def record_applied_success, do: GenServer.cast(__MODULE__, :applied_success)

  @spec record_failure(term()) :: :ok
  def record_failure(reason), do: GenServer.cast(__MODULE__, {:failure, reason})

  @doc """
  승격 조건 점검 후 Telegram 알림 + DB 기록.
  운영이 명시적으로 L5로 고정된 경우에는 승격 후보를 만들지 않는다.
  그 외 모드에서는 자동 flip 없이 알림만 발송하고 마스터 승인 대기.
  MapeKLoop 주간 Knowledge 단계에서 호출.
  """
  @spec check_promotion_conditions() :: :ok
  def check_promotion_conditions do
    try do
      state = GenServer.call(__MODULE__, :get)
      current = state.level
      successes = state.consecutive_successes
      applied = state.applied_successes
      days = days_since_struct(state.level_upgraded_at)

      cond do
        forced_l5?() ->
          Logger.debug("[darwin/autonomy] 운영 L5 고정 모드 — 승격 후보 체크 생략")

        current == 3 and successes >= 5 and days >= 7 ->
          log_candidate(current, 4, %{successes: successes, applications: applied, days: days, violations: 0})

        current == 4 and successes >= 10 and applied >= 3 and days >= 14
            and Darwin.V2.KillSwitch.enabled?(:l5) ->
          log_candidate(current, 5, %{successes: successes, applications: applied, days: days, violations: 0})

        true ->
          Logger.debug("[darwin/autonomy] 승격 조건 미충족 (L#{current}, 성공 #{successes}, 경과 #{days}일)")
      end
    rescue
      e -> Logger.warning("[darwin/autonomy] check_promotion_conditions 오류: #{inspect(e)}")
    end
    :ok
  end

  # ---

  @impl GenServer
  def init(_opts) do
    state = load_state()
    :ets.new(@table, [:set, :public, :named_table])
    sync_ets(state)
    Logger.info("[darwin/autonomy] 자율 레벨 L#{state.level} 로드 완료")
    {:ok, state}
  end

  @impl GenServer
  def handle_call(:get, _from, state) do
    {:reply, Map.from_struct(state), state}
  end

  def handle_call(:level, _from, state) do
    {:reply, state.level, state}
  end

  @impl GenServer
  def handle_cast(:success, state) do
    new = %{state |
      consecutive_successes: state.consecutive_successes + 1,
      last_success_at: DateTime.utc_now(),
      pipeline_runs: state.pipeline_runs + 1
    }
    new = maybe_upgrade(new)
    sync_ets(new)
    persist(new)
    {:noreply, new}
  end

  def handle_cast(:applied_success, state) do
    new = %{state |
      consecutive_successes: state.consecutive_successes + 1,
      applied_successes: state.applied_successes + 1,
      last_success_at: DateTime.utc_now(),
      pipeline_runs: state.pipeline_runs + 1
    }
    new = maybe_upgrade(new)
    sync_ets(new)
    persist(new)
    {:noreply, new}
  end

  def handle_cast({:failure, reason}, state) do
    Logger.warning("[darwin/autonomy] 파이프라인 실패 → L3 강등: #{inspect(reason)}")
    new = %{state | consecutive_successes: 0, level: 3}
    sync_ets(new)
    persist(new)
    {:noreply, new}
  end

  # ---

  defp maybe_upgrade(%{level: 3, consecutive_successes: s, last_success_at: last} = state) when s >= 5 do
    days = days_since(last)
    if days >= 7 do
      Logger.info("[darwin/autonomy] L3→L4 승격! (#{s}회 성공, #{days}일 경과)")
      new = %{state | level: 4, level_upgraded_at: DateTime.utc_now()}
      Task.start(fn ->
        HubClient.post_alarm("🎉 다윈팀 자율 레벨 L3→L4 승격!\n연속 성공: #{s}회\n경과: #{days}일", "darwin", "darwin")
      end)
      new
    else
      Logger.debug("[darwin/autonomy] L3 승격 대기: #{days}/7일 경과")
      state
    end
  end

  defp maybe_upgrade(%{level: 4, consecutive_successes: s, applied_successes: a, level_upgraded_at: up} = state)
       when s >= 10 and a >= 3 do
    days = days_since(up)
    if days >= 14 do
      Logger.info("[darwin/autonomy] L4→L5 완전자율 달성! (#{s}회 성공, #{a}회 적용, #{days}일 경과)")
      new = %{state | level: 5, level_upgraded_at: DateTime.utc_now()}
      Task.start(fn ->
        HubClient.post_alarm(
          "🏆 다윈팀 완전자율 L5 달성!\n연속 성공: #{s}회\n적용 성공: #{a}회\n경과: #{days}일",
          "darwin", "darwin"
        )
      end)
      new
    else
      Logger.debug("[darwin/autonomy] L4 승격 대기: #{days}/14일 경과")
      state
    end
  end

  defp maybe_upgrade(state), do: state

  defp days_since(nil), do: 0
  defp days_since(dt), do: DateTime.diff(DateTime.utc_now(), dt, :day)

  defp days_since_struct(nil), do: 0
  defp days_since_struct(%DateTime{} = dt), do: DateTime.diff(DateTime.utc_now(), dt, :day)
  defp days_since_struct(_), do: 0

  defp log_candidate(from_level, to_level, stats) do
    sql = """
    INSERT INTO darwin_autonomy_promotion_log
      (from_level, to_level, stats, approver, telegram_sent_at, inserted_at)
    VALUES ($1, $2, $3::jsonb, 'candidate', NOW(), NOW())
    """
    Jay.Core.Repo.query(sql, [from_level, to_level, Jason.encode!(stats)])

    msg = """
    🧬 다윈 자율 레벨 승격 후보 감지
    현재: L#{from_level} → 제안: L#{to_level}
    - 성공 사이클: #{stats.successes}회
    - 적용 완료: #{stats.applications}회
    - 경과 일수: #{stats.days}일
    마스터 승인 후 DARWIN_AUTONOMY_LEVEL=#{to_level} 적용 (자동 flip 없음)
    """

    Task.start(fn -> HubClient.post_alarm(msg, "darwin", "darwin") end)
    Logger.info("[darwin/autonomy] 승격 후보 기록: L#{from_level}→L#{to_level}")
  rescue
    e -> Logger.warning("[darwin/autonomy] log_candidate 오류: #{inspect(e)}")
  end

  defp sync_ets(state) do
    :ets.insert(@table, {:level, state.level})
    :ets.insert(@table, {:consecutive_successes, state.consecutive_successes})
    :ets.insert(@table, {:applied_successes, state.applied_successes})
  end

  defp load_state do
    path = Path.join(System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system"), @autonomy_file)
    env_level = System.get_env("DARWIN_AUTONOMY_LEVEL")
    case File.read(path) do
      {:ok, content} ->
        data = Jason.decode!(content)
        %__MODULE__{
          level: normalize_level(env_level || data["level"] || 3),
          consecutive_successes: data["consecutiveSuccesses"] || 0,
          applied_successes: data["appliedSuccesses"] || 0
        }
      _ ->
        %__MODULE__{level: normalize_level(env_level || 3)}
    end
  end

  defp persist(state) do
    path = Path.join(System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system"), @autonomy_file)
    content = Jason.encode!(%{
      level: state.level,
      consecutiveSuccesses: state.consecutive_successes,
      appliedSuccesses: state.applied_successes,
      upgradedAt: DateTime.to_iso8601(state.level_upgraded_at || DateTime.utc_now())
    })
    File.write(path, content)
  end

  defp normalize_level(level) when is_integer(level) and level in 3..5, do: level
  defp normalize_level("L3"), do: 3
  defp normalize_level("L4"), do: 4
  defp normalize_level("L5"), do: 5
  defp normalize_level("3"), do: 3
  defp normalize_level("4"), do: 4
  defp normalize_level("5"), do: 5
  defp normalize_level(_), do: 3

  defp forced_l5? do
    normalize_level(System.get_env("DARWIN_AUTONOMY_LEVEL")) == 5 and
      System.get_env("DARWIN_KILL_SWITCH", "false") != "true"
  end
end
