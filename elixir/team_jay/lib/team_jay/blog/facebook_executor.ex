defmodule TeamJay.Blog.FacebookExecutor do
  @moduledoc """
  블로그팀 Facebook 채널 실행 준비기.

  `handoff:facebook` 이벤트를 받아 실제 페이지 게시 직전의
  실행 payload를 만든다.
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
    {:ok, _ref} = PubSub.subscribe(Topics.handoff("facebook"))

    {:ok,
     %{
       prepared_count: 0,
       last_prepared_at: nil,
       last_items: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       prepared_count: state.prepared_count,
       last_prepared_at: state.last_prepared_at,
       last_items: state.last_items
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:handoff_ready, "facebook", queued}}, state) do
    execution = build_execution(queued)
    :ok = PubSub.broadcast_execution("facebook", execution)

    {:noreply,
     %{
       state
       | prepared_count: state.prepared_count + 1,
         last_prepared_at: DateTime.utc_now(),
         last_items: [execution | Enum.take(state.last_items, 4)]
     }}
  end

  defp build_execution(queued) do
    payload = Map.get(queued, :payload, %{})

    %{
      target: "facebook",
      execution_status: :prepared,
      execution_note: "Phase 1 facebook executor prepared page publish scaffold",
      channel: "facebook",
      message: build_message(payload),
      link: build_link(payload),
      payload: payload
    }
  end

  defp build_message(payload) do
    post_type = payload[:post_type] || "post"
    writer = payload[:writer] || "writer"
    date = payload[:date] || "date"
    "Phase1 #{post_type} #{writer} #{date} Facebook 공유 준비"
  end

  defp build_link(payload) do
    payload[:published_url] || payload[:url] || nil
  end
end
