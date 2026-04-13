defmodule TeamJay.Blog.InstagramAgent do
  @moduledoc """
  블로그팀 인스타그램 채널 스캐폴드.

  `social:instagram` 이벤트를 받아 실제 업로드 전에 필요한
  채널 payload를 정리하고 큐잉 상태를 만든다.

  현재는 업로드 호출 없이, 인스타 전용 준비 상태만 고정한다.
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
    {:ok, _ref} = PubSub.subscribe(Topics.social("instagram"))

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
  def handle_info({:blog_event, _topic, {:social_ready, "instagram", relay}}, state) do
    queued = build_instagram_queue(relay)
    :ok = PubSub.broadcast_handoff("instagram", queued)

    {:noreply,
     %{
       state
       | queued_count: state.queued_count + 1,
         last_queued_at: DateTime.utc_now(),
         last_items: [queued | Enum.take(state.last_items, 4)]
     }}
  end

  defp build_instagram_queue(relay) do
    %{
      channel: "instagram",
      queue_status: :queued,
      queue_note: "Phase 1 instagram agent scaffold queued",
      payload: relay.payload
    }
  end
end
