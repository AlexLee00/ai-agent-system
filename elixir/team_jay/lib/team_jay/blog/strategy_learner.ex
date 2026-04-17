defmodule TeamJay.Blog.StrategyLearner do
  @moduledoc """
  :blog_insights_collected 이벤트를 받아 성과 분석 → 전략 자동 조정 GenServer.

  동작:
    1. init에서 :blog_insights_collected 구독
    2. 이벤트 수신 시 일간 학습 (analyze-blog-performance.ts)
    3. 매주 월요일 07:00 KST (일요일 22:00 UTC) 주간 전략 진화 (weekly-evolution.ts)
    4. Phase 1: 텔레그램 알림 + 마스터 확인 요청
    5. Phase 2+: 조용히 적용

  상태:
    - last_learned_date: 마지막 일간 학습 날짜
    - last_weekly_at: 마지막 주간 진화 시각
    - current_phase: 현재 자율 단계 (기본값 1)
  """

  use GenServer
  require Logger
  alias Jay.V2.Topics

  @weekly_evolution_hour_utc 22  # 일요일 22:00 UTC = 월요일 07:00 KST

  defstruct [
    last_learned_date: nil,
    last_weekly_at: nil,
    current_phase: 1,
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[StrategyLearner] 전략 학습 서비스 시작")
    Topics.subscribe(:blog_insights_collected)
    schedule_next_weekly_evolution()
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info({:jay_bus, :blog_insights_collected, payload}, state) do
    {:noreply, do_learn(payload, state)}
  end

  @impl true
  def handle_info(:weekly_evolution, state) do
    new_state = do_weekly_evolution(state)
    schedule_next_weekly_evolution()
    {:noreply, new_state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ─── 일간 학습 ────────────────────────────────────────────

  defp do_learn(_payload, state) do
    today = Date.utc_today()
    already_today = state.last_learned_date == today

    if already_today do
      Logger.debug("[StrategyLearner] 오늘 이미 학습 완료 — 스킵")
      state
    else
      Logger.info("[StrategyLearner] 일간 성과 분석 시작 (#{today})")

      case run_node_script("bots/blog/scripts/analyze-blog-performance.ts --json") do
        {:ok, output} ->
          case Jason.decode(output) do
            {:ok, result} ->
              broadcast_strategy_updated(result, state.current_phase)
              notify_strategy(result, state.current_phase)
              Logger.info("[StrategyLearner] ✅ 일간 학습 완료 (#{today})")
              %{state | last_learned_date: today}

            {:error, reason} ->
              Logger.warning("[StrategyLearner] JSON 파싱 실패: #{inspect(reason)}")
              state
          end

        {:error, reason} ->
          Logger.warning("[StrategyLearner] 스크립트 실행 실패: #{inspect(reason)}")
          state
      end
    end
  rescue
    e ->
      Logger.warning("[StrategyLearner] do_learn 예외: #{inspect(e)}")
      state
  end

  # ─── 주간 전략 진화 ──────────────────────────────────────

  defp do_weekly_evolution(state) do
    Logger.info("[StrategyLearner] 주간 전략 진화 시작")

    case run_node_script("bots/blog/scripts/weekly-evolution.ts --json") do
      {:ok, output} ->
        case Jason.decode(output) do
          {:ok, result} ->
            new_phase = get_in(result, ["autonomy", "currentPhase"]) || 1
            broadcast_strategy_updated(result, new_phase)
            notify_weekly_evolution(result, new_phase)
            Logger.info("[StrategyLearner] ✅ 주간 전략 진화 완료 (Phase #{new_phase})")
            %{state | last_weekly_at: DateTime.utc_now(), current_phase: new_phase}

          {:error, reason} ->
            Logger.warning("[StrategyLearner] 주간 JSON 파싱 실패: #{inspect(reason)}")
            state
        end

      {:error, reason} ->
        Logger.warning("[StrategyLearner] 주간 스크립트 실행 실패: #{inspect(reason)}")
        state
    end
  rescue
    e ->
      Logger.warning("[StrategyLearner] do_weekly_evolution 예외: #{inspect(e)}")
      state
  end

  # ─── JayBus 브로드캐스트 ─────────────────────────────────

  defp broadcast_strategy_updated(result, phase) do
    Topics.broadcast(:blog_strategy_updated, %{
      result: result,
      phase: phase,
      updated_at: DateTime.utc_now()
    })
  rescue
    e -> Logger.warning("[StrategyLearner] 브로드캐스트 실패: #{inspect(e)}")
  end

  # ─── 텔레그램 알림 ───────────────────────────────────────

  defp notify_strategy(result, phase) do
    analyzed = result["analyzedPosts"] || 0

    message =
      if phase == 1 do
        "[블로팀] 전략 업데이트 (마스터 확인 요청): 분석 #{analyzed}건"
      else
        "[블로팀] 전략 자동 적용: 분석 #{analyzed}건"
      end

    Jay.Core.HubClient.post_alarm(message, "blog", "strategy_learner")
  rescue
    _ -> :ok
  end

  defp notify_weekly_evolution(result, phase) do
    analyzed = get_in(result, ["evolution", "plan", "focus"]) || []
    focus_str = Enum.join(analyzed, " | ")

    message =
      if phase == 1 do
        "[블로팀] 전략 업데이트 (마스터 확인 요청): 분석 #{length(analyzed)}건, 포커스: #{focus_str}"
      else
        "[블로팀] 전략 자동 적용: 분석 #{length(analyzed)}건"
      end

    Jay.Core.HubClient.post_alarm(message, "blog", "strategy_learner")
  rescue
    _ -> :ok
  end

  # ─── 주간 스케줄링 (일요일 22:00 UTC) ────────────────────

  defp schedule_next_weekly_evolution do
    now_utc = DateTime.utc_now()
    # 일요일 = 7 (Date.day_of_week 기준)
    days_until_sunday = rem(7 - Date.day_of_week(DateTime.to_date(now_utc)), 7)

    target_date =
      if days_until_sunday == 0 do
        # 오늘이 일요일
        today_target = %{now_utc | hour: @weekly_evolution_hour_utc, minute: 0, second: 0, microsecond: {0, 0}}
        if DateTime.compare(now_utc, today_target) == :lt do
          today_target
        else
          DateTime.add(today_target, 7 * 86_400, :second)
        end
      else
        base = %{now_utc | hour: @weekly_evolution_hour_utc, minute: 0, second: 0, microsecond: {0, 0}}
        DateTime.add(base, days_until_sunday * 86_400, :second)
      end

    ms_until = DateTime.diff(target_date, now_utc, :millisecond)
    Logger.debug("[StrategyLearner] 다음 주간 진화: #{div(ms_until, 3_600_000)}시간 후")
    Process.send_after(self(), :weekly_evolution, ms_until)
  end

  # ─── Node.js 스크립트 실행 ───────────────────────────────

  defp run_node_script(script) do
    project_root = Application.get_env(:team_jay, :project_root, "/Users/alexlee/projects/ai-agent-system")
    tsx = Path.join(project_root, "node_modules/.bin/tsx")
    [cmd | args] = String.split(script, " ")
    script_path = Path.join(project_root, cmd)
    timeout_ms = 120_000

    task =
      Task.async(fn ->
        System.cmd(tsx, [script_path | args],
          cd: project_root,
          stderr_to_stdout: true
        )
      end)

    case Task.yield(task, timeout_ms) || Task.shutdown(task, :brutal_kill) do
      {:ok, {output, 0}} ->
        {:ok, String.trim(output)}

      {:ok, {output, code}} ->
        {:error, "exit #{code}: #{String.slice(output, 0, 300)}"}

      nil ->
        {:error, "command_timeout after #{timeout_ms}ms"}
    end
  rescue
    e -> {:error, inspect(e)}
  end
end
