defmodule Luna.V2.Validation.Engine do
  @moduledoc """
  Chronos 기반 Validation Engine — 전략 4단계 검증 파이프라인.

  Stage 1: Backtest (6개월 trade_history)
  Stage 2: WalkForward (90일 rolling 3구간)
  Stage 3: ShadowValidation (luna_v2_shadow_comparison 7일)
  Stage 4: ValidationLive (소액 실계좌 14일)
  → PromotionGate.decide/1 → :promote | :hold | :demote

  Status: backtest → shadow → validation_live → normal_live
  매일 03:00 KST 자동 실행.
  """
  use GenServer
  require Logger

  alias Luna.V2.Registry.StrategyRegistry
  alias Luna.V2.Validation.{Backtest, WalkForward, ShadowValidation, ValidationLive, PromotionGate}

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def validate_strategy(strategy_id, opts \\ []) do
    GenServer.call(__MODULE__, {:validate, strategy_id, opts}, 300_000)
  end

  def run_all_pending do
    GenServer.cast(__MODULE__, :run_all_pending)
  end

  # ─── GenServer ───────────────────────────────────────────────────

  def init(_opts) do
    schedule_daily_validation()
    {:ok, %{running: [], last_run: nil}}
  end

  def handle_call({:validate, strategy_id, opts}, _from, state) do
    result = do_validate(strategy_id, opts)
    {:reply, result, %{state | last_run: DateTime.utc_now()}}
  end

  def handle_cast(:run_all_pending, state) do
    Task.start(fn ->
      Logger.info("[Validation.Engine] 자동 검증 실행 시작")
      case StrategyRegistry.list(nil, "backtest") do
        {:ok, strategies} ->
          Enum.each(strategies, fn s ->
            strategy_id = s["strategy_id"] || s[:strategy_id]
            case do_validate(strategy_id, []) do
              {:ok, verdict} -> Logger.info("[Validation] #{strategy_id}: #{inspect(verdict.verdict)}")
              {:error, e}    -> Logger.warning("[Validation] #{strategy_id} 실패: #{inspect(e)}")
            end
          end)
        _ -> :ok
      end
    end)
    {:noreply, state}
  end

  def handle_info(:daily_validation, state) do
    run_all_pending()
    schedule_daily_validation()
    {:noreply, %{state | last_run: DateTime.utc_now()}}
  end

  # ─── 검증 파이프라인 ─────────────────────────────────────────────

  defp do_validate(strategy_id, _opts) do
    with {:ok, strategy}      <- StrategyRegistry.get(strategy_id),
         {:ok, bt_result}     <- Backtest.run(strategy),
         {:ok, wf_result}     <- WalkForward.run(strategy),
         {:ok, shadow_result} <- ShadowValidation.run(strategy),
         {:ok, live_result}   <- ValidationLive.run(strategy),
         {:ok, verdict}       <- PromotionGate.decide([bt_result, wf_result, shadow_result, live_result]) do
      StrategyRegistry.record_validation(strategy_id, verdict)
      save_validation_run(strategy_id, strategy, [bt_result, wf_result, shadow_result, live_result], verdict)
      {:ok, verdict}
    end
  end

  defp save_validation_run(strategy_id, strategy, results, verdict) do
    metrics = Jason.encode!(%{
      backtest:        Enum.find(results, &(&1[:type] == :backtest)),
      walk_forward:    Enum.find(results, &(&1[:type] == :walk_forward)),
      shadow:          Enum.find(results, &(&1[:type] == :shadow)),
      validation_live: Enum.find(results, &(&1[:type] == :validation_live)),
      verdict:         verdict
    })
    query = """
    INSERT INTO luna_strategy_validation_runs
      (strategy_id, version, validation_type, period_from, period_to, metrics)
    VALUES ($1, $2, 'full_pipeline', NOW() - INTERVAL '6 months', NOW(), $3)
    """
    Jay.Core.Repo.query(query, [strategy_id, strategy[:version] || "1.0.0", metrics])
  rescue
    _ -> :ok
  end

  defp schedule_daily_validation do
    # 매일 03:00 KST = 18:00 UTC
    now = DateTime.utc_now()
    seconds_until = calc_seconds_until(now, 18)
    Process.send_after(self(), :daily_validation, seconds_until * 1_000)
  end

  defp calc_seconds_until(now, target_hour) do
    today_target = %{now | hour: target_hour, minute: 0, second: 0, microsecond: {0, 0}}
    diff = DateTime.diff(today_target, now)
    if diff > 0, do: diff, else: diff + 86_400
  end
end
