defmodule TeamJay.Blog.NaverBlogExecutor do
  @moduledoc """
  블로그팀 네이버 블로그 채널 실행 준비기.

  `handoff:naver_blog` 이벤트를 받아 실제 복붙/발행 직전의 실행 payload를 만든다.
  현재는 title/body_source/channel 메타만 담는 scaffold execution을 만든다.
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
    {:ok, _ref} = PubSub.subscribe(Topics.handoff("naver_blog"))

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
  def handle_info({:blog_event, _topic, {:handoff_ready, "naver_blog", queued}}, state) do
    execution = build_execution(queued)
    :ok = PubSub.broadcast_execution("naver_blog", execution)

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
      target: "naver_blog",
      execution_status: :prepared,
      execution_note: "Phase 1 naver blog executor prepared publish scaffold",
      channel: "naver_blog",
      title: build_title(payload),
      body_source: :node_blog_output,
      payload: payload
    }
  end

  defp build_title(payload) do
    post_type = payload[:post_type] || "post"
    date = payload[:date] || "date"
    "Phase1 #{post_type} #{date}"
  end
end
