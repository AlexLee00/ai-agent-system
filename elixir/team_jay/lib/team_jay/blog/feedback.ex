defmodule TeamJay.Blog.Feedback do
  @moduledoc """
  블로그팀 피드백 수집 스캐폴드.

  `published` 이벤트를 받아 이후 성과/댓글/반응 데이터를 연결할
  피드백 키를 만들고 `feedback:*` 토픽으로 브로드캐스트한다.

  현재는 실제 외부 수집 없이, 후속 학습용 이벤트 흐름만 고정한다.
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
    {:ok, _ref} = PubSub.subscribe(Topics.published())

    {:ok,
     %{
       feedback_count: 0,
       last_feedback_at: nil,
       last_items: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       feedback_count: state.feedback_count,
       last_feedback_at: state.last_feedback_at,
       last_items: state.last_items
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:published, published}}, state) do
    feedback = build_feedback_payload(published)
    :ok = PubSub.broadcast(Topics.feedback(feedback.feedback_key), {:feedback_ready, feedback})

    {:noreply,
     %{
       state
       | feedback_count: state.feedback_count + 1,
         last_feedback_at: DateTime.utc_now(),
         last_items: [feedback | Enum.take(state.last_items, 4)]
     }}
  end

  defp build_feedback_payload(published) do
    feedback_key = "#{published.post_type}:#{published.date}:#{published.writer || "unknown"}"

    %{
      feedback_key: feedback_key,
      feedback_status: :prepared,
      feedback_note: "Phase 1 feedback scaffold prepared",
      payload: published
    }
  end
end
