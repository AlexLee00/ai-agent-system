defmodule TeamJay.Blog.Researcher do
  @moduledoc """
  블로그팀 리서처 GenServer 스캐폴드.

  현재는 Orchestrator가 보낸 일정 이벤트를 받아
  오늘의 리서치 큐를 상태로 보관하고 `research_done` 토픽으로
  스캐폴드 결과를 브로드캐스트한다.

  실제 외부 조사/Node.js 연동은 다음 단계에서 붙인다.
  """

  use GenServer

  alias TeamJay.Blog.PubSub
  alias TeamJay.Blog.Topics

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def status do
    GenServer.call(__MODULE__, :status)
  end

  @impl true
  def init(_opts) do
    {:ok, _ref} = PubSub.subscribe(Topics.schedule())

    {:ok,
     %{
       queue: [],
       completed: [],
       last_started_at: nil,
       last_completed_at: nil
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       queue_size: length(state.queue),
       completed_size: length(state.completed),
       last_started_at: state.last_started_at,
       last_completed_at: state.last_completed_at,
       queue: state.queue
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:start_research, posts}}, state) when is_list(posts) do
    result = build_research_result(posts)
    :ok = PubSub.broadcast(Topics.research_done(), {:research_done, result})

    {:noreply,
     %{
       state
       | queue: posts,
         completed: result.items,
         last_started_at: DateTime.utc_now(),
         last_completed_at: DateTime.utc_now()
     }}
  end

  defp build_research_result(posts) do
    %{
      generated_at: DateTime.utc_now(),
      items:
        Enum.map(posts, fn post ->
          Map.merge(post, %{
            status: :scaffolded,
            sources: [],
            note: "Phase 1 researcher scaffold"
          })
        end)
    }
  end
end
