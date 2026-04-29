defmodule Luna.V2.KillSwitch do
  @moduledoc """
  Luna V2 Kill Switch — 환경변수 기반 4단계 기능 제어.

  기본 ALL OFF 안전 모드.
  단계적으로 ON: Shadow → Commander → MAPE-K → LIVE

  환경변수:
    LUNA_V2_ENABLED=true           → V2 수퍼바이저 전체 기동
    LUNA_COMMANDER_ENABLED=true    → Commander (Jido.AI.Agent) 활성
    LUNA_MAPEK_ENABLED=true        → MAPE-K 자율 루프 활성
    LUNA_AUTO_MODE=true            → 완전 자율 모드 (마스터 개입 최소)
    LUNA_LLM_HUB_ENABLED=true      → Hub LLM 라우팅 활성 (TS 레이어)
    LUNA_LLM_HUB_SHADOW=true       → Shadow 비교 모드

    LIVE 전환 (Phase 5):
    LUNA_LIVE_CRYPTO=true          → 암호화폐 실거래 (이미 true)
    LUNA_LIVE_DOMESTIC=true        → 국내주식 실거래 전환 (기본 false)
    LUNA_LIVE_OVERSEAS=true        → 국외주식 실거래 전환 (기본 false)

    Validation:
    LUNA_VALIDATION_ENABLED=true   → Validation Engine 활성
    LUNA_PREDICTION_ENABLED=true   → Prediction Engine 활성
    LUNA_RAG_ENABLED=true          → Agentic RAG 활성
  """

  @runtime_override_filename "position-runtime-overrides.json"
  @legacy_runtime_override_file "/Users/alexlee/projects/ai-agent-system/bots/investment/output/ops/position-runtime-overrides.json"

  defp runtime_override_file do
    runtime_dir =
      System.get_env("INVESTMENT_OPS_RUNTIME_DIR") ||
        Path.join([System.user_home!(), ".ai-agent-system", "investment", "ops"])

    Path.join(runtime_dir, @runtime_override_filename)
  rescue
    _ -> @legacy_runtime_override_file
  end

  defp runtime_override_read_file do
    file = runtime_override_file()

    if File.exists?(file) do
      file
    else
      @legacy_runtime_override_file
    end
  end

  defp runtime_override(key) when is_atom(key) do
    file = runtime_override_read_file()

    with true <- File.exists?(file),
         {:ok, raw} <- File.read(file),
         {:ok, overrides} <- Jason.decode(raw),
         value when not is_nil(value) <- Map.get(overrides, Atom.to_string(key)) do
      value
    else
      _ -> nil
    end
  end

  defp get_env_override(key, fallback) when is_atom(key) do
    runtime_override(key) || Application.get_env(:luna, key, fallback)
  end

  def v2_enabled?, do: Application.get_env(:luna, :v2_enabled, false)
  def commander_enabled?, do: Application.get_env(:luna, :commander_enabled, false)
  def mapek_enabled?, do: Application.get_env(:luna, :mapek_enabled, false)
  def shadow_mode?, do: Application.get_env(:luna, :shadow_mode, false)
  def hub_routing?, do: Application.get_env(:luna, :hub_routing, false)
  def auto_mode?, do: Application.get_env(:luna, :auto_mode, false)

  # LIVE 전환 Kill Switch
  def live_crypto?, do: Application.get_env(:luna, :live_crypto, true)
  def live_domestic?, do: Application.get_env(:luna, :live_domestic, false)
  def live_overseas?, do: Application.get_env(:luna, :live_overseas, false)

  @doc "시장별 LIVE 여부."
  def live_enabled?(:crypto), do: live_crypto?()
  def live_enabled?(:domestic), do: live_domestic?()
  def live_enabled?(:overseas), do: live_overseas?()
  def live_enabled?(_), do: false

  # 개별 구성요소
  def validation_enabled?, do: Application.get_env(:luna, :validation_enabled, false)
  def prediction_enabled?, do: Application.get_env(:luna, :prediction_enabled, false)
  def rag_enabled?, do: Application.get_env(:luna, :rag_enabled, false)
  def strategy_registry_enabled?, do: v2_enabled?()

  # Phase 5a
  def scheduler_enabled?, do: Application.get_env(:luna, :scheduler_enabled, false)
  def telegram_enabled?, do: Application.get_env(:luna, :telegram_enabled, false)
  def position_watch_enabled?, do: Application.get_env(:luna, :position_watch_enabled, true)

  def position_watch_interval_ms,
    do: get_env_override(:position_watch_interval_ms, 60_000)

  def position_watch_idle_ms, do: get_env_override(:position_watch_idle_ms, 60_000)

  def position_watch_crypto_realtime_ms,
    do: get_env_override(:position_watch_crypto_realtime_ms, 15_000)

  def position_watch_domestic_realtime_ms do
    case get_env_override(:position_watch_domestic_realtime_ms, nil) do
      nil -> position_watch_stock_realtime_ms()
      value -> value
    end
  end

  def position_watch_overseas_realtime_ms do
    case get_env_override(:position_watch_overseas_realtime_ms, nil) do
      nil -> position_watch_stock_realtime_ms()
      value -> value
    end
  end

  def position_watch_stock_realtime_ms,
    do: get_env_override(:position_watch_stock_realtime_ms, 15_000)

  def position_watch_stock_offhours_ms,
    do: get_env_override(:position_watch_stock_offhours_ms, 300_000)

  def position_watch_fallback_ms,
    do: get_env_override(:position_watch_fallback_ms, 60_000)

  def position_watch_stop_loss_pct,
    do: Application.get_env(:luna, :position_watch_stop_loss_pct, 0.05)

  def position_watch_adjust_gain_pct,
    do: Application.get_env(:luna, :position_watch_adjust_gain_pct, 0.10)

  def position_watch_stale_minutes,
    do: Application.get_env(:luna, :position_watch_stale_minutes, 120)

  def position_watch_crypto_dust_usdt,
    do: Application.get_env(:luna, :position_watch_crypto_dust_usdt, 10.0)

  def position_watch_tv_enabled?, do: Application.get_env(:luna, :position_watch_tv_enabled, true)

  def position_watch_tv_base_url,
    do: Application.get_env(:luna, :position_watch_tv_base_url, "http://127.0.0.1:8083")

  def position_watch_tv_timeframes,
    do: Application.get_env(:luna, :position_watch_tv_timeframes, ["1h", "4h"])

  def position_watch_tv_stale_ms,
    do: Application.get_env(:luna, :position_watch_tv_stale_ms, 180_000)

  def position_watch_active_backtest_enabled?,
    do: Application.get_env(:luna, :position_watch_active_backtest_enabled, true)

  def position_watch_active_backtest_days,
    do: Application.get_env(:luna, :position_watch_active_backtest_days, 30)

  def position_watch_active_backtest_cooldown_minutes,
    do: Application.get_env(:luna, :position_watch_active_backtest_cooldown_minutes, 30)

  def position_watch_active_backtest_max_per_tick,
    do: Application.get_env(:luna, :position_watch_active_backtest_max_per_tick, 2)

  def position_watch_backtest_drift_enabled?,
    do: Application.get_env(:luna, :position_watch_backtest_drift_enabled, true)

  def position_watch_backtest_drift_min_trades,
    do: Application.get_env(:luna, :position_watch_backtest_drift_min_trades, 4)

  def position_watch_backtest_drift_adjust_sharpe_drop,
    do: Application.get_env(:luna, :position_watch_backtest_drift_adjust_sharpe_drop, 0.75)

  def position_watch_backtest_drift_exit_sharpe_drop,
    do: Application.get_env(:luna, :position_watch_backtest_drift_exit_sharpe_drop, 1.5)

  def position_watch_backtest_drift_adjust_return_drop_pct,
    do: Application.get_env(:luna, :position_watch_backtest_drift_adjust_return_drop_pct, 5.0)

  def position_watch_backtest_drift_exit_return_drop_pct,
    do: Application.get_env(:luna, :position_watch_backtest_drift_exit_return_drop_pct, 10.0)

  def position_watch_strategy_exit_enabled?,
    do: Application.get_env(:luna, :position_watch_strategy_exit_enabled, true)

  def position_watch_strategy_exit_cooldown_minutes,
    do: Application.get_env(:luna, :position_watch_strategy_exit_cooldown_minutes, 30)

  def position_watch_strategy_exit_max_per_tick,
    do: Application.get_env(:luna, :position_watch_strategy_exit_max_per_tick, 2)

  def position_watch_reevaluation_enabled?,
    do: Application.get_env(:luna, :position_watch_reevaluation_enabled, true)

  def position_watch_reevaluation_cooldown_minutes,
    do: Application.get_env(:luna, :position_watch_reevaluation_cooldown_minutes, 10)

  def position_watch_reevaluation_max_per_tick,
    do: Application.get_env(:luna, :position_watch_reevaluation_max_per_tick, 3)

  # Agent Memory Layer 1 (Working Memory)
  def layer1_working_memory_enabled?,
    do: Application.get_env(:luna, :layer1_working_memory_enabled, false)

  def layer1_working_memory_ttl_ms,
    do: Application.get_env(:luna, :layer1_working_memory_ttl_ms, 900_000)

  def layer1_working_memory_prune_interval_ms,
    do: Application.get_env(:luna, :layer1_working_memory_prune_interval_ms, 60_000)
end
