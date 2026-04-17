defmodule Jay.Core.MarketRegime do
  @moduledoc """
  시장 체제 감지 + 가이드 상태 관리 GenServer.
  """
  use GenServer
  require Logger

  @regime_guides %{
    trending_bull: %{
      description: "강한 상승 추세",
      agent_weights: %{zeus: 1.5, athena: 0.5, argos: 1.2, scout: 1.0},
      trading_style: :aggressive,
      tp_multiplier: 1.3,
      sl_multiplier: 1.0,
      position_size_multiplier: 1.2
    },
    trending_bear: %{
      description: "강한 하락 추세",
      agent_weights: %{zeus: 0.5, athena: 1.5, argos: 0.8, scout: 1.0},
      trading_style: :defensive,
      tp_multiplier: 0.8,
      sl_multiplier: 0.7,
      position_size_multiplier: 0.5
    },
    ranging: %{
      description: "횡보장",
      agent_weights: %{zeus: 1.0, athena: 1.0, argos: 1.0, scout: 1.0},
      trading_style: :neutral,
      tp_multiplier: 0.7,
      sl_multiplier: 0.7,
      position_size_multiplier: 0.8
    },
    volatile: %{
      description: "급변동",
      agent_weights: %{zeus: 0.3, athena: 1.8, argos: 0.5, scout: 1.2},
      trading_style: :defensive,
      tp_multiplier: 1.5,
      sl_multiplier: 0.5,
      position_size_multiplier: 0.3
    }
  }

  defstruct [:current_regime, :confidence, :reason, :history, :updated_at]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    Logger.info("[MarketRegime] 시작! 기본 체제: ranging")

    {:ok,
     %__MODULE__{
       current_regime: :ranging,
       confidence: 0.5,
       reason: "초기 상태",
       history: [],
       updated_at: DateTime.utc_now()
     }}
  end

  def detect(signals) when is_map(signals), do: GenServer.call(__MODULE__, {:detect, signals})
  def get_current, do: GenServer.call(__MODULE__, :get_current)
  def get_guide, do: GenServer.call(__MODULE__, :get_guide)
  def get_history(count \\ 20), do: GenServer.call(__MODULE__, {:get_history, count})

  @impl true
  def handle_call({:detect, signals}, _from, state) do
    result = do_detect(signals)
    new_history = [{result, DateTime.utc_now()} | Enum.take(state.history, 99)]

    if result.regime != state.current_regime do
      Logger.info("[MarketRegime] 체제 변경! #{state.current_regime} → #{result.regime}")

      Jay.Core.EventLake.record(%{
        event_type: "market_regime_changed",
        team: "investment",
        bot_name: "market-regime",
        severity: if(result.regime == :volatile, do: "warn", else: "info"),
        title: "시장 체제 변경: #{result.regime}",
        message: result.reason,
        metadata: %{
          from: state.current_regime,
          to: result.regime,
          confidence: result.confidence
        }
      })
    end

    new_state = %{
      state
      | current_regime: result.regime,
        confidence: result.confidence,
        reason: result.reason,
        history: new_history,
        updated_at: DateTime.utc_now()
    }

    {:reply, result, new_state}
  end

  def handle_call(:get_current, _from, state) do
    {:reply, %{regime: state.current_regime, confidence: state.confidence, reason: state.reason}, state}
  end

  def handle_call(:get_guide, _from, state) do
    {:reply, Map.get(@regime_guides, state.current_regime), state}
  end

  def handle_call({:get_history, count}, _from, state) do
    {:reply, Enum.take(state.history, count), state}
  end

  defp do_detect(signals) do
    aria = Map.get(signals, :aria, %{})
    sophia = Map.get(signals, :sophia, %{})

    rsi = Map.get(aria, :rsi, 50) |> to_float()
    atr_ratio = Map.get(aria, :atr_ratio, 1.0) |> to_float()
    sentiment = Map.get(sophia, :sentiment, 0) |> to_float()
    trend = Map.get(aria, :trend, "neutral") |> to_string() |> String.downcase()

    cond do
      atr_ratio > 2.0 ->
        %{regime: :volatile, confidence: min(0.9, atr_ratio / 3), reason: "ATR #{Float.round(atr_ratio, 1)}x → 급변동", guide: @regime_guides.volatile}

      trend in ["up", "bullish"] and rsi > 50 and sentiment > 0 ->
        %{regime: :trending_bull, confidence: min(0.9, (rsi - 50) / 50 + abs(sentiment)), reason: "RSI=#{round(rsi)} 감성=#{Float.round(sentiment, 2)} 상승", guide: @regime_guides.trending_bull}

      trend in ["down", "bearish"] and rsi < 50 and sentiment < 0 ->
        %{regime: :trending_bear, confidence: min(0.9, (50 - rsi) / 50 + abs(sentiment)), reason: "RSI=#{round(rsi)} 감성=#{Float.round(sentiment, 2)} 하락", guide: @regime_guides.trending_bear}

      true ->
        %{regime: :ranging, confidence: 0.5, reason: "RSI=#{round(rsi)} 감성=#{Float.round(sentiment, 2)} 횡보", guide: @regime_guides.ranging}
    end
  end

  defp to_float(v) when is_float(v), do: v
  defp to_float(v) when is_integer(v), do: v * 1.0
  defp to_float(_), do: 0.0
end

