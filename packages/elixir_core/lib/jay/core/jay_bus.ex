defmodule Jay.Core.JayBus do
  @moduledoc """
  Jay Core JayBus — 팀 간 이벤트 라우팅 Registry 래퍼.

  기존 `{Registry, keys: :duplicate, name: TeamJay.JayBus}`를 대체.

  토픽 규약:
  - darwin.paper.evaluated
  - darwin.sensor.arxiv
  - sigma.advisory.darwin.*
  - jay.cycle.started / jay.cycle.completed

  루나팀 실시간 토픽:
  - luna.tv.bar.{symbol}.{timeframe}      TradingView OHLCV
  - luna.binance.trade.{symbol}           Binance 체결 tick
  - luna.binance.orderbook.{symbol}       Binance orderbook
  - luna.binance.kline.{symbol}.{tf}      Binance 실시간 봉
  - luna.kis.tick.{symbol}               KIS 체결
  - luna.kis.quote.{symbol}              KIS 호가
  - luna.analyst.result.{agent}          분석 결과
  - luna.decision.candidate.{symbol}     Luna 후보 결정
  - luna.policy.verdict.{symbol}         Nemesis 승인/거부
  - luna.execution.order.{symbol}        주문 발행
  - luna.execution.fill.{symbol}         체결 완료
  - luna.review.trade.{id}              Chronos 거래 회고
  - luna.circuit.breaker.{event}         Circuit Breaker 이벤트
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
    topic
    |> dispatch_topics()
    |> Enum.flat_map(&Registry.lookup(__MODULE__, &1))
    |> Enum.uniq_by(fn {pid, _meta} -> pid end)
    |> Enum.each(fn {pid, _meta} -> send(pid, {:jay_bus, topic, payload}) end)

    :ok
  end

  @doc "루나팀 전용 발행 헬퍼"
  def publish_luna(topic, payload) do
    publish(topic, {:luna_event, topic, payload})
  end

  @doc "루나팀 전용 구독 헬퍼"
  def subscribe_luna(topic) do
    subscribe(topic)
  end

  defp dispatch_topics(topic) do
    [topic | luna_parent_topics(topic)]
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
  end

  defp luna_parent_topics(topic) do
    topic_text = topic_to_string(topic)

    if String.starts_with?(topic_text, "luna.") do
      parts = String.split(topic_text, ".")

      (length(parts) - 1)..3//-1
      |> Enum.map(fn size -> parts |> Enum.take(size) |> Enum.join(".") end)
      |> Enum.reject(&(&1 == topic_text))
      |> Enum.map(&same_topic_type(topic, &1))
    else
      []
    end
  end

  defp topic_to_string(topic) when is_atom(topic), do: Atom.to_string(topic)
  defp topic_to_string(topic) when is_binary(topic), do: topic
  defp topic_to_string(topic), do: to_string(topic)

  defp same_topic_type(topic, topic_text) when is_atom(topic) do
    String.to_existing_atom(topic_text)
  rescue
    ArgumentError -> nil
  end

  defp same_topic_type(topic, topic_text) when is_binary(topic), do: topic_text
  defp same_topic_type(_topic, topic_text), do: topic_text
end
