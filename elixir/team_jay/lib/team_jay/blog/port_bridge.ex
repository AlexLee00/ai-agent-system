defmodule TeamJay.Blog.PortBridge do
  @moduledoc """
  블로그팀 Node 런타임 브리지 스캐폴드.

  `published` 이벤트를 받아 Node.js 블로그 런타임으로 넘길
  handoff payload와 예상 명령을 준비한다.

  현재는 실제 `Port` 실행 대신, handoff 상태와 이벤트만 고정한다.
  """

  use GenServer

  alias TeamJay.Blog.PubSub
  alias TeamJay.Blog.Topics

  @daily_script "/Users/alexlee/projects/ai-agent-system/bots/blog/scripts/run-daily.ts"

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def status do
    GenServer.call(__MODULE__, :status)
  end

  @impl true
  def init(_opts) do
    {:ok, _ref} = PubSub.subscribe(Topics.published())

    {:ok,
     %{
       handoff_count: 0,
       last_handoff_at: nil,
       last_items: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       handoff_count: state.handoff_count,
       last_handoff_at: state.last_handoff_at,
       last_items: state.last_items
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:published, published}}, state) do
    handoff = build_handoff(published)
    :ok = PubSub.broadcast(Topics.handoff("node_publish"), {:handoff_ready, "node_publish", handoff})

    {:noreply,
     %{
       state
       | handoff_count: state.handoff_count + 1,
         last_handoff_at: DateTime.utc_now(),
         last_items: [handoff | Enum.take(state.last_items, 4)]
     }}
  end

  defp build_handoff(published) do
    %{
      target: "node_publish",
      handoff_status: :prepared,
      handoff_note: "Phase 1 port bridge scaffold prepared",
      command: "node",
      args: [@daily_script, "--json"],
      payload: published
    }
  end
end
