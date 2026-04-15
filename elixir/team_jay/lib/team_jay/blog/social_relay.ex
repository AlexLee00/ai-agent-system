defmodule TeamJay.Blog.SocialRelay do
  @moduledoc """
  블로그팀 소셜 릴레이 스캐폴드.

  `published` 이벤트를 받아 후속 채널 배포용 payload를 만들고
  `social:*` 토픽으로 fan-out 한다.

  현재는 실제 업로드 대신 채널별 준비 상태만 고정한다.
  """

  use GenServer

  alias TeamJay.Blog.PubSub
  alias TeamJay.Blog.Topics

  @channels ["instagram", "naver_blog", "facebook"]

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
       relayed_count: 0,
       last_relayed_at: nil,
       last_items: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       relayed_count: state.relayed_count,
       last_relayed_at: state.last_relayed_at,
       last_items: state.last_items
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:published, published}}, state) do
    relays =
      Enum.map(@channels, fn channel ->
        relay = build_relay_payload(channel, published)
        :ok = PubSub.broadcast(Topics.social(channel), {:social_ready, channel, relay})
        relay
      end)

    {:noreply,
     %{
       state
       | relayed_count: state.relayed_count + length(relays),
         last_relayed_at: DateTime.utc_now(),
         last_items: relays ++ Enum.take(state.last_items, max(0, 6 - length(relays)))
     }}
  end

  defp build_relay_payload(channel, published) do
    %{
      channel: channel,
      relay_status: :prepared,
      relay_note: "Phase 1 social relay scaffold prepared",
      payload: published
    }
  end
end
