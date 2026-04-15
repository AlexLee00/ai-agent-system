defmodule TeamJay.Investment.PubSub do
  @moduledoc """
  투자팀 전용 이벤트 버스 스캐폴드.

  Phase 1 설계에서는 Phoenix.PubSub를 목표로 하지만, 현재는 병렬 운영에
  영향 없는 Registry 기반 shim으로 subscribe/broadcast 흐름만 고정한다.
  """

  @registry TeamJay.InvestmentBus

  def subscribe(topic) when is_binary(topic) do
    Registry.register(@registry, topic, [])
  end

  def unsubscribe(topic) when is_binary(topic) do
    Registry.unregister(@registry, topic)
  end

  def broadcast(topic, message) when is_binary(topic) do
    Registry.dispatch(@registry, topic, fn entries ->
      Enum.each(entries, fn {pid, _meta} -> send(pid, {:investment_event, topic, message}) end)
    end)

    :ok
  end

  def broadcast_trade_event(symbol, event) do
    TeamJay.Investment.Topics.trade_events(symbol)
    |> broadcast(event)
  end

  def broadcast_indicator(symbol, indicator_payload) do
    TeamJay.Investment.Topics.indicators(symbol)
    |> broadcast(indicator_payload)
  end

  def broadcast_price_tick(symbol, tick_payload) do
    TeamJay.Investment.Topics.price_ticks(symbol)
    |> broadcast(tick_payload)
  end

  def broadcast_position_state(symbol, position_payload) do
    TeamJay.Investment.Topics.position_state(symbol)
    |> broadcast(position_payload)
  end

  def broadcast_condition_check(symbol, condition_payload) do
    TeamJay.Investment.Topics.condition_checks(symbol)
    |> broadcast(condition_payload)
  end

  def broadcast_strategy_update(symbol, update_payload) do
    TeamJay.Investment.Topics.strategy_updates(symbol)
    |> broadcast(update_payload)
  end

  def broadcast_runtime_override(symbol, override_payload) do
    TeamJay.Investment.Topics.runtime_overrides(symbol)
    |> broadcast(override_payload)
  end
end
