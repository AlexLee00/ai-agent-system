defmodule TeamJay.Blog.TopicPlanner do
  @moduledoc """
  D-1 주제 사전 선정 GenServer.

  매일 21:00 KST (12:00 UTC)에 실행:
    1. topic-planner.ts 호출 → 내일 카테고리 + 최우선 주제 1건 선정
    2. blog.topic_queue에 저장 (TS 스크립트가 직접 INSERT)
    3. 텔레그램 알림: "내일 주제: [카테고리] 제목"

  run_now/0로 수동 트리거 가능.
  """

  use GenServer
  require Logger

  @plan_hour_utc 12  # 21:00 KST

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def run_now do
    GenServer.cast(__MODULE__, :run_now)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[TopicPlanner] D-1 주제 사전 선정 서비스 시작")
    schedule_next_plan()
    {:ok, %{last_planned_date: nil}}
  end

  @impl true
  def handle_cast(:run_now, state) do
    new_state = do_plan(state)
    {:noreply, new_state}
  end

  @impl true
  def handle_info(:plan, state) do
    new_state = do_plan(state)
    schedule_next_plan()
    {:noreply, new_state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ─── 실행 ─────────────────────────────────────────────────

  defp do_plan(state) do
    today = Date.utc_today()

    if state.last_planned_date == today do
      Logger.debug("[TopicPlanner] 오늘 이미 실행됨 (#{today}) — 건너뜀")
      state
    else
      run_topic_planner(state, today)
    end
  end

  defp run_topic_planner(state, today) do
    Logger.info("[TopicPlanner] 내일 주제 선정 시작 (#{today})")

    # 내일 날짜 계산
    tomorrow = Date.add(today, 1)
    tomorrow_str = Date.to_iso8601(tomorrow)

    result = run_node_script("bots/blog/scripts/topic-planner.ts --date=#{tomorrow_str} --json")

    case result do
      {:ok, output} ->
        handle_success(output, tomorrow_str, %{state | last_planned_date: today})

      {:error, reason} ->
        Logger.error("[TopicPlanner] 실행 실패: #{inspect(reason)}")
        Jay.Core.HubClient.post_alarm(
          "[블로팀] ⚠️ D-1 주제 선정 실패 (#{tomorrow_str}): #{inspect(reason)}",
          "blog",
          "topic_planner"
        )
        state
    end
  rescue
    e ->
      Logger.warning("[TopicPlanner] 예외: #{inspect(e)}")
      state
  end

  defp handle_success(output, tomorrow_str, state) do
    case Jason.decode(output) do
      {:ok, %{"ok" => true} = result} ->
        category = result["category"] || "미정"
        title    = result["title"]    || ""
        score    = result["quality_score"] || 0
        saved_id = result["saved_id"]

        Logger.info("[TopicPlanner] ✅ 내일 주제: [#{category}] #{title} (점수: #{score}, id: #{saved_id})")

        Jay.Core.HubClient.post_alarm(
          "[블로팀] 📅 내일 주제 확정 (#{tomorrow_str})\n[#{category}] #{title}\n품질 점수: #{score}",
          "blog",
          "topic_planner"
        )

        state

      {:ok, %{"ok" => false} = result} ->
        Logger.warning("[TopicPlanner] 결과 ok=false: #{inspect(result)}")
        state

      _ ->
        Logger.warning("[TopicPlanner] JSON 파싱 실패: #{inspect(String.slice(output, 0, 200))}")
        state
    end
  rescue
    e ->
      Logger.warning("[TopicPlanner] handle_success 예외: #{inspect(e)}")
      state
  end

  # ─── Node.js 스크립트 실행 ────────────────────────────────

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
        {:error, "exit #{code}: #{String.slice(output, 0, 200)}"}

      nil ->
        {:error, "command_timeout after #{timeout_ms}ms"}
    end
  rescue
    e -> {:error, Exception.message(e)}
  end

  # ─── 스케줄링 (매일 12:00 UTC = 21:00 KST) ───────────────

  defp schedule_next_plan do
    now_utc = DateTime.utc_now()
    target_today = %{now_utc | hour: @plan_hour_utc, minute: 0, second: 0, microsecond: {0, 0}}

    ms_until =
      if DateTime.compare(now_utc, target_today) == :lt do
        DateTime.diff(target_today, now_utc, :millisecond)
      else
        tomorrow_target = DateTime.add(target_today, 86_400, :second)
        DateTime.diff(tomorrow_target, now_utc, :millisecond)
      end

    Logger.debug("[TopicPlanner] 다음 실행: #{div(ms_until, 60_000)}분 후")
    Process.send_after(self(), :plan, ms_until)
  end
end
