defmodule Darwin.V2.SignalReceiver do
  @moduledoc """
  Sigma Advisory Signal Receiver — 시그마 V2 Commander가 보내는 권고 신호 구독.
  sigma.advisory.darwin.* 토픽 구독:
  - knowledge_capture: 스탠딩 오더 승격
  - research_topic: 연구 큐 등록
  - priority_boost: 특정 도메인 우선 탐색
  """

  use GenServer
  require Logger

  @subscribed_topics [
    "sigma.advisory.darwin.knowledge_capture",
    "sigma.advisory.darwin.research_topic",
    "sigma.advisory.darwin.priority_boost"
  ]

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl GenServer
  def init(_opts) do
    Enum.each(@subscribed_topics, fn topic ->
      Phoenix.PubSub.subscribe(Darwin.V2.PubSub, topic)
    end)
    Logger.info("[darwin/signal] Sigma advisory 구독: #{inspect(@subscribed_topics)}")
    {:ok, %{received: 0}}
  end

  @impl GenServer
  def handle_info({:sigma_advisory, %{topic: "sigma.advisory.darwin.knowledge_capture"} = signal}, state) do
    data = signal[:data] || %{}
    Logger.info("[darwin/signal] 지식 축적 권고: #{data[:topic]}")
    handle_knowledge_capture(data)
    {:noreply, %{state | received: state.received + 1}}
  end

  def handle_info({:sigma_advisory, %{topic: "sigma.advisory.darwin.research_topic"} = signal}, state) do
    data = signal[:data] || %{}
    Logger.info("[darwin/signal] 연구 주제 권고: #{inspect(data[:keywords])}")
    handle_research_topic(data)
    {:noreply, %{state | received: state.received + 1}}
  end

  def handle_info({:sigma_advisory, %{topic: "sigma.advisory.darwin.priority_boost"} = signal}, state) do
    data = signal[:data] || %{}
    Logger.info("[darwin/signal] 우선 탐색 권고: domain=#{data[:domain]}")
    handle_priority_boost(data)
    {:noreply, %{state | received: state.received + 1}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ---

  defp handle_knowledge_capture(data) do
    Task.start(fn ->
      Jay.Core.HubClient.post_alarm(
        "[다윈] 시그마 권고 → 스탠딩 오더 승격: #{data[:topic] || "(미명시)"}",
        "darwin",
        "darwin"
      )
    end)
  end

  defp handle_research_topic(data) do
    keywords = data[:keywords] || []
    # 커뮤니티 스캐너에 키워드 우선 탐색 요청
    Darwin.V2.Memory.L1.store(:priority_topic, %{keywords: keywords, source: :sigma, urgency: data[:urgency]}, importance: 0.9)
  end

  defp handle_priority_boost(data) do
    Darwin.V2.Memory.L1.store(:priority_domain, %{domain: data[:domain], boost: data[:boost] || 2.0}, importance: 0.85)
  end
end
