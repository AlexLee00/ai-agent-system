defmodule TeamJay.Ska.Analytics.Forecast do
  @moduledoc """
  스카팀 예측 모델 GenServer.

  Python forecast.py를 System.cmd로 호출하고 결과를 DB에서 조회.
  매일 18:00 (launchd ai.ska.forecast) Python이 독립 실행하므로
  이 GenServer는 조회·트리거·결과 캐싱 역할만 담당.

  주요 기능:
    - get_latest/1       : 최신 예측 결과 조회 (daily/weekly/monthly)
    - get_accuracy/0     : 최근 7일 MAPE (정확도)
    - trigger_forecast/1 : Python forecast.py 즉시 실행 (수동 트리거)
    - get_summary/0      : 예측 KPI 스냅샷
  """

  use GenServer
  require Logger

  @python_bin "bots/ska/venv/bin/python"
  @forecast_script "bots/ska/src/forecast.py"
  @forecast_timeout_ms 5 * 60 * 1_000  # 5분

  defstruct [
    latest_daily: nil,
    latest_weekly: nil,
    latest_monthly: nil,
    last_fetched_at: nil
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "최신 예측 결과 조회 (:daily | :weekly | :monthly)"
  def get_latest(mode \\ :daily) do
    GenServer.call(__MODULE__, {:get_latest, mode})
  end

  @doc "최근 7일 평균 MAPE (%) — 모델 정확도"
  def get_accuracy do
    GenServer.call(__MODULE__, :get_accuracy)
  end

  @doc "Python forecast.py 즉시 실행 (수동 트리거용)"
  def trigger_forecast(mode \\ :daily) do
    GenServer.cast(__MODULE__, {:trigger_forecast, mode})
  end

  @doc "예측 KPI 전체 스냅샷"
  def get_summary do
    GenServer.call(__MODULE__, :get_summary)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[Forecast] 스카팀 예측 모듈 시작")
    # 시작 후 30초에 최신 예측 캐시 로딩
    Process.send_after(self(), :refresh_cache, 30_000)
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_call({:get_latest, mode}, _from, state) do
    result = case mode do
      :daily   -> state.latest_daily   || query_latest(:daily)
      :weekly  -> state.latest_weekly  || query_latest(:weekly)
      :monthly -> state.latest_monthly || query_latest(:monthly)
      _ -> {:error, :invalid_mode}
    end
    {:reply, result, state}
  end

  @impl true
  def handle_call(:get_accuracy, _from, state) do
    result = query_accuracy(7)
    {:reply, result, state}
  end

  @impl true
  def handle_call(:get_summary, _from, state) do
    daily = state.latest_daily || query_latest(:daily)
    accuracy = query_accuracy(7)

    summary = %{
      latest_daily: daily,
      accuracy_7d_mape: extract_mape(accuracy),
      last_fetched_at: state.last_fetched_at,
      model_version: "prophet-v3"
    }
    {:reply, {:ok, summary}, state}
  end

  @impl true
  def handle_cast({:trigger_forecast, mode}, state) do
    Logger.info("[Forecast] 수동 트리거: --mode=#{mode}")
    spawn(fn -> run_python_forecast(mode) end)
    {:noreply, state}
  end

  @impl true
  def handle_info(:refresh_cache, state) do
    new_state = refresh_all(state)
    Process.send_after(self(), :refresh_cache, 30 * 60 * 1_000)  # 30분마다 갱신
    {:noreply, new_state}
  end

  # ─── DB 조회 ─────────────────────────────────────────────

  defp query_latest(mode) do
    mode_str = Atom.to_string(mode)
    case Jay.Core.HubClient.pg_query("""
      SELECT forecast_date::text, predictions, mape, model_version, created_at::text
      FROM ska.forecast_results
      WHERE model_version LIKE 'prophet%'
      ORDER BY created_at DESC
      LIMIT 1
    """, "ska") do
      {:ok, %{"rows" => [row]}} ->
        {:ok, %{
          forecast_date: row["forecast_date"],
          predictions: row["predictions"],
          mape: row["mape"],
          model_version: row["model_version"],
          mode: mode_str,
          fetched_at: DateTime.utc_now()
        }}
      {:ok, %{"rows" => []}} ->
        Logger.debug("[Forecast] 예측 결과 없음 (mode=#{mode_str})")
        {:ok, nil}
      {:error, reason} ->
        Logger.warning("[Forecast] query_latest 실패: #{inspect(reason)}")
        {:error, reason}
    end
  rescue
    e ->
      Logger.warning("[Forecast] query_latest 예외: #{inspect(e)}")
      {:error, :query_failed}
  end

  defp query_accuracy(days) do
    case Jay.Core.HubClient.pg_query("""
      SELECT
        ROUND(AVG(mape)::numeric, 2) AS avg_mape,
        COUNT(*) AS sample_count,
        MIN(forecast_date)::text AS from_date,
        MAX(forecast_date)::text AS to_date
      FROM ska.forecast_results
      WHERE forecast_date >= (CURRENT_DATE - INTERVAL '#{days} days')
        AND mape IS NOT NULL
    """, "ska") do
      {:ok, %{"rows" => [row]}} ->
        {:ok, %{
          avg_mape: row["avg_mape"],
          sample_count: row["sample_count"],
          from_date: row["from_date"],
          to_date: row["to_date"],
          days: days
        }}
      {:error, reason} ->
        Logger.warning("[Forecast] query_accuracy 실패: #{inspect(reason)}")
        {:error, reason}
    end
  rescue
    e ->
      Logger.warning("[Forecast] query_accuracy 예외: #{inspect(e)}")
      {:error, :query_failed}
  end

  # ─── Python 실행 ──────────────────────────────────────────

  defp run_python_forecast(mode) do
    root = Application.get_env(:team_jay, :project_root,
      System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system"))

    python = Path.join(root, @python_bin)
    script = Path.join(root, @forecast_script)
    args   = [script, "--mode=#{mode}", "--json"]

    Logger.info("[Forecast] Python 실행: #{python} #{Enum.join(args, " ")}")

    case System.cmd(python, args,
           cd: root,
           stderr_to_stdout: true,
           timeout: @forecast_timeout_ms) do
      {output, 0} ->
        Logger.info("[Forecast] 완료 (mode=#{mode}): #{String.slice(output, 0, 200)}")
        {:ok, output}
      {output, exit_code} ->
        Logger.error("[Forecast] 실패 (mode=#{mode}, exit=#{exit_code}): #{String.slice(output, 0, 500)}")
        Jay.Core.HubClient.post_alarm(
          "⚠️ [스카] forecast.py 실패 (mode=#{mode}, exit=#{exit_code})\n#{String.slice(output, 0, 300)}",
          "ska", "forecast"
        )
        {:error, exit_code}
    end
  rescue
    e ->
      Logger.error("[Forecast] Python 실행 예외: #{inspect(e)}")
      {:error, e}
  end

  defp refresh_all(state) do
    daily = case query_latest(:daily) do
      {:ok, r} -> r
      _ -> state.latest_daily
    end
    weekly = case query_latest(:weekly) do
      {:ok, r} -> r
      _ -> state.latest_weekly
    end
    monthly = case query_latest(:monthly) do
      {:ok, r} -> r
      _ -> state.latest_monthly
    end

    %{state |
      latest_daily: daily,
      latest_weekly: weekly,
      latest_monthly: monthly,
      last_fetched_at: DateTime.utc_now()
    }
  end

  defp extract_mape({:ok, %{avg_mape: mape}}), do: mape
  defp extract_mape(_), do: nil
end
