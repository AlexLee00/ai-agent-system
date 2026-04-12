defmodule TeamJay.Blog.Orchestrator do
  @moduledoc """
  블로그팀 Phase 1 전환용 오케스트레이터 스캐폴드.

  현재는 Node.js + launchd 메인 경로를 대체하지 않고,
  Elixir 쪽에서 일정 계획과 PubSub 흐름을 미리 고정하기 위한 얇은 GenServer다.
  """

  use GenServer
  require Logger

  alias TeamJay.Blog.PubSub

  @default_plan %{lecture_count: 1, general_count: 1}

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def state do
    GenServer.call(__MODULE__, :state)
  end

  def plan_today do
    GenServer.call(__MODULE__, :plan_today)
  end

  def trigger_daily_run do
    GenServer.cast(__MODULE__, :trigger_daily_run)
  end

  @impl true
  def init(_opts) do
    state = %{
      today_posts: [],
      last_planned_at: nil,
      last_broadcast_at: nil
    }

    {:ok, state}
  end

  @impl true
  def handle_call(:state, _from, state) do
    {:reply, state, state}
  end

  @impl true
  def handle_call(:plan_today, _from, state) do
    posts = build_today_posts()
    next_state = %{state | today_posts: posts, last_planned_at: DateTime.utc_now()}
    {:reply, posts, next_state}
  end

  @impl true
  def handle_cast(:trigger_daily_run, state) do
    posts = build_today_posts()
    :ok = PubSub.broadcast_schedule(posts)

    Logger.info("[blog-orchestrator] broadcast schedule #{inspect(posts)}")

    next_state = %{
      state
      | today_posts: posts,
        last_planned_at: DateTime.utc_now(),
        last_broadcast_at: DateTime.utc_now()
    }

    {:noreply, next_state}
  end

  defp build_today_posts do
    today =
      DateTime.utc_now()
      |> DateTime.add(9 * 60 * 60, :second)
      |> DateTime.to_date()
      |> Date.to_iso8601()

    [
      %{date: today, post_type: :lecture, count: @default_plan.lecture_count},
      %{date: today, post_type: :general, count: @default_plan.general_count}
    ]
  end
end
