defmodule TeamJay.Blog.AlertRelay do
  @moduledoc """
  블로그팀 Phase 1 execution alert 릴레이.

  `execution_alert:node_publish` 이벤트를 구독해서 최근 경고를 메모리에 모은다.
  EventLake 적재는 ExecutionMonitor가 담당하고, 이 모듈은 운영 상태 조회용
  경량 릴레이로 동작한다.
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
    {:ok, _ref} = PubSub.subscribe(Topics.execution_alert("node_publish"))

    {:ok,
     %{
       alert_count: 0,
       last_alert_at: nil,
       last_alerts: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       alert_count: state.alert_count,
       last_alert_at: state.last_alert_at,
       last_alerts: state.last_alerts
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:execution_alert, "node_publish", alert}}, state) do
    {:noreply,
     %{
       state
       | alert_count: state.alert_count + 1,
         last_alert_at: DateTime.utc_now(),
         last_alerts: [alert | Enum.take(state.last_alerts, 4)]
     }}
  end
end
