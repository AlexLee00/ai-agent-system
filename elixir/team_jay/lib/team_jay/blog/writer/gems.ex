defmodule TeamJay.Blog.Writer.Gems do
  @moduledoc """
  블로그팀 일반 포스팅 writer 스캐폴드.

  `research_done` 이벤트를 받아 general 포스트만 골라
  `draft_ready("gems")` 토픽으로 스캐폴드 draft를 발행한다.
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
    {:ok, _ref} = PubSub.subscribe(Topics.research_done())

    {:ok,
     %{
       writer: "gems",
       drafted_count: 0,
       last_draft_at: nil,
       last_items: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       writer: state.writer,
       drafted_count: state.drafted_count,
       last_draft_at: state.last_draft_at,
       last_items: state.last_items
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:research_done, result}}, state) do
    drafts =
      result.items
      |> Enum.filter(&(&1.post_type == :general))
      |> Enum.map(&build_draft/1)

    Enum.each(drafts, fn draft ->
      :ok = PubSub.broadcast_draft_ready("gems", draft)
    end)

    {:noreply,
     %{
       state
       | drafted_count: state.drafted_count + length(drafts),
         last_draft_at: if(drafts == [], do: state.last_draft_at, else: DateTime.utc_now()),
         last_items: drafts
     }}
  end

  defp build_draft(item) do
    Map.merge(item, %{
      writer: "gems",
      draft_status: :scaffolded,
      note: "Phase 1 gems writer scaffold"
    })
  end
end
