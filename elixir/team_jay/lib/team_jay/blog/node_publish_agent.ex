defmodule TeamJay.Blog.NodePublishAgent do
  @moduledoc """
  블로그팀 Node publish handoff 스캐폴드.

  `handoff:node_publish` 이벤트를 받아 실제 Node 블로그 런타임 호출 전의
  실행 payload를 큐잉한다.

  현재는 실제 Port 실행 없이, Node handoff 준비 상태만 고정한다.
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
    {:ok, _ref} = PubSub.subscribe(Topics.handoff("node_publish"))

    {:ok,
     %{
       queued_count: 0,
       last_queued_at: nil,
       last_items: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       queued_count: state.queued_count,
       last_queued_at: state.last_queued_at,
       last_items: state.last_items
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:handoff_ready, "node_publish", handoff}}, state) do
    queued = build_publish_queue(handoff)

    {:noreply,
     %{
       state
       | queued_count: state.queued_count + 1,
         last_queued_at: DateTime.utc_now(),
         last_items: [queued | Enum.take(state.last_items, 4)]
     }}
  end

  defp build_publish_queue(handoff) do
    %{
      target: "node_publish",
      queue_status: :queued,
      queue_note: "Phase 1 node publish agent scaffold queued",
      command: handoff.command,
      args: handoff.args,
      payload: handoff.payload
    }
  end
end
