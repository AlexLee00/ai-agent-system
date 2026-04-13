defmodule TeamJay.Blog.Publisher do
  @moduledoc """
  블로그팀 발행기 GenServer 스캐폴드.

  `quality_approved` 이벤트를 받아 발행 준비가 끝난 포스트를
  `published` 토픽으로 넘기는 얇은 Phase 1 브리지 역할을 맡는다.

  현재는 실제 Node.js 퍼블리셔 호출 대신,
  발행 이벤트와 상태만 고정하는 안전한 스캐폴드다.
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
    {:ok, _ref} = PubSub.subscribe(Topics.quality_approved())

    {:ok,
     %{
       published_count: 0,
       last_published_at: nil,
       last_items: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       published_count: state.published_count,
       last_published_at: state.last_published_at,
       last_items: state.last_items
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:quality_approved, approved}}, state) do
    published = build_published_payload(approved)
    :ok = PubSub.broadcast_published(published)

    {:noreply,
     %{
       state
       | published_count: state.published_count + 1,
         last_published_at: DateTime.utc_now(),
         last_items: [published | Enum.take(state.last_items, 4)]
     }}
  end

  defp build_published_payload(approved) do
    Map.merge(approved, %{
      publisher: "phase1-publisher",
      publish_status: :published,
      publish_note: "Phase 1 publisher scaffold published"
    })
  end
end
