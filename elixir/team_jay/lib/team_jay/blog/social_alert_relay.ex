defmodule TeamJay.Blog.SocialAlertRelay do
  @moduledoc """
  블로그팀 소셜 채널 execution alert 릴레이.

  인스타그램과 네이버 블로그 채널의 execution alert를 받아
  최근 경고를 메모리에 유지한다.
  """

  use GenServer

  alias TeamJay.Blog.PubSub
  alias TeamJay.Blog.Topics

  @channels ["instagram", "naver_blog"]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def status do
    GenServer.call(__MODULE__, :status)
  end

  @impl true
  def init(_opts) do
    Enum.each(@channels, fn channel ->
      {:ok, _ref} = PubSub.subscribe(Topics.execution_alert(channel))
    end)

    {:ok,
     %{
       alert_count: 0,
       by_channel: %{
         "instagram" => %{alert_count: 0},
         "naver_blog" => %{alert_count: 0}
       },
       last_alert_at: nil,
       last_alerts: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       alert_count: state.alert_count,
       by_channel: state.by_channel,
       last_alert_at: state.last_alert_at,
       last_alerts: state.last_alerts
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:execution_alert, channel, alert}}, state)
      when channel in @channels do
    channel_state =
      state.by_channel
      |> Map.get(channel, %{alert_count: 0})
      |> Map.update!(:alert_count, &(&1 + 1))

    {:noreply,
     %{
       state
       | alert_count: state.alert_count + 1,
         by_channel: Map.put(state.by_channel, channel, channel_state),
         last_alert_at: DateTime.utc_now(),
         last_alerts: [Map.put(alert, :channel, channel) | Enum.take(state.last_alerts, 4)]
     }}
  end
end
