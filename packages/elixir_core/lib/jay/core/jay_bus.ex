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
    Registry.dispatch(__MODULE__, topic, fn subscribers ->
      for {pid, _meta} <- subscribers do
        send(pid, {:jay_bus, topic, payload})
      end
    end)
  end

  @doc "루나팀 전용 발행 헬퍼"
  def publish_luna(topic, payload) do
    publish(topic, {:luna_event, topic, payload})
  end

  @doc "루나팀 전용 구독 헬퍼"
  def subscribe_luna(topic) do
    subscribe(topic)
  end
end
