defmodule Jay.Core.JayBus do
  @moduledoc """
  Jay Core JayBus — 팀 간 이벤트 라우팅 Registry 래퍼.

  기존 `{Registry, keys: :duplicate, name: TeamJay.JayBus}`를 대체.

  토픽 규약:
  - darwin.paper.evaluated
  - darwin.sensor.arxiv
  - sigma.advisory.darwin.*
  - jay.cycle.started / jay.cycle.completed
  """

  def child_spec(_opts) do
    Registry.child_spec(keys: :duplicate, name: __MODULE__)
  end

  @doc "토픽 구독"
  def subscribe(topic, metadata \\ []) do
    Registry.register(__MODULE__, topic, metadata)
  end

  @doc "토픽 발행"
  def publish(topic, payload) do
    Registry.dispatch(__MODULE__, topic, fn subscribers ->
      for {pid, _meta} <- subscribers do
        send(pid, {:jay_bus, topic, payload})
      end
    end)
  end
end
