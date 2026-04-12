defmodule TeamJay.Blog.Editor do
  @moduledoc """
  블로그팀 편집기 GenServer 스캐폴드.

  Writer 단계에서 발행한 `draft_ready:*` 이벤트를 받아
  가벼운 편집 결과를 만들고 `quality_approved` 토픽으로 넘긴다.

  현재는 실편집/품질 검사 대신 이벤트 흐름을 고정하는 역할만 맡는다.
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
    {:ok, _ref_pos} = PubSub.subscribe(Topics.draft_ready("pos"))
    {:ok, _ref_gems} = PubSub.subscribe(Topics.draft_ready("gems"))

    {:ok,
     %{
       approved_count: 0,
       last_approved_at: nil,
       last_items: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       approved_count: state.approved_count,
       last_approved_at: state.last_approved_at,
       last_items: state.last_items
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:draft_ready, writer, draft}}, state) do
    approved = build_approved_draft(writer, draft)
    :ok = PubSub.broadcast(Topics.quality_approved(), {:quality_approved, approved})

    {:noreply,
     %{
       state
       | approved_count: state.approved_count + 1,
         last_approved_at: DateTime.utc_now(),
         last_items: [approved | Enum.take(state.last_items, 4)]
     }}
  end

  defp build_approved_draft(writer, draft) do
    Map.merge(draft, %{
      editor: "phase1-editor",
      writer: writer,
      quality_status: :approved,
      quality_note: "Phase 1 editor scaffold approved"
    })
  end
end
