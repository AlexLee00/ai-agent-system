defmodule TeamJay.Blog.ContentLoop do
  @moduledoc """
  6단계 자율 콘텐츠 루프 상태 추적 GenServer.

  6단계: PLAN → CREATE → PUBLISH → COLLECT → ANALYZE → LEARN

  동작:
    1. JayBus 구독으로 단계 완료 감지:
       - :blog_content_planned → PLAN 완료
       - :blog_insights_collected → COLLECT 완료
       - :blog_strategy_updated → ANALYZE + LEARN 완료
    2. 매일 22:00 UTC (07:00 KST 다음날) :daily_check
       - CREATE/PUBLISH: DB 쿼리로 확인
       - 모든 6단계 완료 시 텔레그램 요약 알림
       - 미완료 단계 있으면 경고 알림
  """

  use GenServer
  require Logger
  alias TeamJay.Jay.Topics

  @daily_check_hour_utc 22

  defstruct [
    loop_date: nil,
    stages: %{},
    completed_at: nil,
  ]

  @empty_stages %{
    plan: false,
    create: false,
    publish: false,
    collect: false,
    analyze: false,
    learn: false
  }

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[ContentLoop] 6단계 콘텐츠 루프 추적 서비스 시작")
    Topics.subscribe(:blog_content_planned)
    Topics.subscribe(:blog_insights_collected)
    Topics.subscribe(:blog_strategy_updated)
    schedule_next_daily_check()
    today = Date.utc_today()
    {:ok, %__MODULE__{loop_date: today, stages: @empty_stages}}
  end

  # ─── JayBus 이벤트 핸들러 ────────────────────────────────

  @impl true
  def handle_info({:jay_bus, :blog_content_planned, _payload}, state) do
    {:noreply, mark_stage(state, :plan)}
  end

  @impl true
  def handle_info({:jay_bus, :blog_insights_collected, _payload}, state) do
    {:noreply, mark_stage(state, :collect)}
  end

  @impl true
  def handle_info({:jay_bus, :blog_strategy_updated, _payload}, state) do
    state = mark_stage(state, :analyze)
    state = mark_stage(state, :learn)
    {:noreply, state}
  end

  # ─── 일일 체크 ────────────────────────────────────────────

  @impl true
  def handle_info(:daily_check, state) do
    new_state = do_daily_check(state)
    schedule_next_daily_check()
    {:noreply, new_state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ─── 일일 체크 실행 ──────────────────────────────────────

  defp do_daily_check(state) do
    today = Date.utc_today()
    yesterday = Date.add(today, -1)

    # 이전 날 루프 완료 여부 체크
    prev_state = check_previous_loop(state, yesterday)

    # 새 루프 시작
    Logger.info("[ContentLoop] 새 루프 시작: #{today}")
    new_state = %__MODULE__{
      loop_date: today,
      stages: @empty_stages,
      completed_at: nil
    }

    # DB에서 오늘 CREATE/PUBLISH 확인
    check_db_stages(new_state, today)

    _ = prev_state
    new_state
  rescue
    e ->
      Logger.warning("[ContentLoop] do_daily_check 예외: #{inspect(e)}")
      state
  end

  defp check_previous_loop(state, yesterday) do
    if state.loop_date == yesterday do
      incomplete = Enum.filter(state.stages, fn {_k, v} -> not v end)
                   |> Enum.map(fn {k, _} -> String.upcase(to_string(k)) end)

      if Enum.empty?(incomplete) or state.completed_at != nil do
        :ok
      else
        Logger.warning("[ContentLoop] ⚠️ 미완료 단계 감지: #{Enum.join(incomplete, ", ")}")
        notify_incomplete(yesterday, incomplete)
      end
    end
    state
  rescue
    e ->
      Logger.warning("[ContentLoop] check_previous_loop 예외: #{inspect(e)}")
      state
  end

  defp check_db_stages(state, date) do
    date_str = Date.to_iso8601(date)

    result = Jay.Core.HubClient.pg_query(
      "SELECT COUNT(*) FROM blog.posts WHERE DATE(publish_date) = '#{date_str}' AND status = 'published'",
      "blog"
    )

    case result do
      {:ok, %{"rows" => [[count | _] | _]}} when is_integer(count) and count > 0 ->
        Logger.info("[ContentLoop] DB 확인: #{count}건 발행됨 (#{date})")
        state
        |> mark_stage(:create)
        |> mark_stage(:publish)

      {:ok, %{"rows" => [[count_str | _] | _]}} ->
        count = parse_count(count_str)
        if count > 0 do
          state
          |> mark_stage(:create)
          |> mark_stage(:publish)
        else
          state
        end

      _ ->
        state
    end
  rescue
    e ->
      Logger.warning("[ContentLoop] check_db_stages 예외: #{inspect(e)}")
      state
  end

  defp parse_count(val) when is_integer(val), do: val
  defp parse_count(val) when is_binary(val) do
    case Integer.parse(val) do
      {n, _} -> n
      :error -> 0
    end
  end
  defp parse_count(_), do: 0

  # ─── 단계 완료 마킹 ──────────────────────────────────────

  defp mark_stage(state, stage) do
    new_stages = Map.put(state.stages, stage, true)
    new_state = %{state | stages: new_stages}

    Logger.info("[ContentLoop] ✅ #{String.upcase(to_string(stage))} 단계 완료 (#{state.loop_date})")

    if all_stages_complete?(new_stages) and state.completed_at == nil do
      Logger.info("[ContentLoop] 🎉 6단계 루프 전체 완료! (#{state.loop_date})")
      notify_loop_complete(state.loop_date)
      %{new_state | completed_at: DateTime.utc_now()}
    else
      new_state
    end
  rescue
    e ->
      Logger.warning("[ContentLoop] mark_stage 예외: #{inspect(e)}")
      state
  end

  defp all_stages_complete?(stages) do
    Enum.all?(stages, fn {_k, v} -> v end)
  end

  # ─── 텔레그램 알림 ───────────────────────────────────────

  defp notify_loop_complete(loop_date) do
    date_str = Date.to_iso8601(loop_date)
    message = "[블로팀] ✅ 6단계 루프 완료 (#{date_str}): PLAN✅ CREATE✅ PUBLISH✅ COLLECT✅ ANALYZE✅ LEARN✅"

    Jay.Core.HubClient.post_alarm(message, "blog", "content_loop")
  rescue
    _ -> :ok
  end

  defp notify_incomplete(loop_date, incomplete_stages) do
    date_str = Date.to_iso8601(loop_date)
    stages_str = Enum.join(incomplete_stages, ", ")
    message = "[블로팀] ⚠️ 루프 미완료 경고 (#{date_str}): #{stages_str} 단계 미완료"

    Jay.Core.HubClient.post_alarm(message, "blog", "content_loop")
  rescue
    _ -> :ok
  end

  # ─── 스케줄링 (매일 22:00 UTC) ───────────────────────────

  defp schedule_next_daily_check do
    now_utc = DateTime.utc_now()
    target_today = %{now_utc | hour: @daily_check_hour_utc, minute: 0, second: 0, microsecond: {0, 0}}

    ms_until =
      if DateTime.compare(now_utc, target_today) == :lt do
        DateTime.diff(target_today, now_utc, :millisecond)
      else
        tomorrow_target = DateTime.add(target_today, 86_400, :second)
        DateTime.diff(tomorrow_target, now_utc, :millisecond)
      end

    Logger.debug("[ContentLoop] 다음 일일 체크: #{div(ms_until, 60_000)}분 후")
    Process.send_after(self(), :daily_check, ms_until)
  end
end
