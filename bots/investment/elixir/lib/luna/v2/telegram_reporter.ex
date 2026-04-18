defmodule Luna.V2.TelegramReporter do
  @moduledoc """
  Luna V2 텔레그램 리포터 — 5채널 알림.

  채널: general / luna_domestic / luna_overseas / luna_crypto / luna_risk
  전송 경로: Hub /hub/telegram/send (Hub Auth Token 경유)

  Kill Switch: LUNA_TELEGRAM_ENABLED=true
  """
  use GenServer
  require Logger

  @channels ~w[general luna_domestic luna_overseas luna_crypto luna_risk]a

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "채널에 메시지 전송."
  def send(channel, message) when channel in @channels do
    GenServer.cast(__MODULE__, {:send, channel, message})
  end
  def send(channel, _message) do
    Logger.warning("[TelegramReporter] 알 수 없는 채널: #{channel}")
    {:error, :unknown_channel}
  end

  @doc "24시간 일일 요약 리포트."
  def daily_summary(market) do
    GenServer.cast(__MODULE__, {:daily_summary, market})
  end

  @doc "7일 주간 요약 리포트."
  def weekly_summary(market) do
    GenServer.cast(__MODULE__, {:weekly_summary, market})
  end

  @doc "채널 목록 반환."
  def channels, do: @channels

  # ─── GenServer ───────────────────────────────────────────────────

  def init(_opts) do
    Logger.info("[TelegramReporter] 기동 — 5채널 준비")
    {:ok, %{sent: 0}}
  end

  def handle_cast({:send, channel, message}, state) do
    do_send(channel, message)
    {:noreply, %{state | sent: state.sent + 1}}
  end

  def handle_cast({:daily_summary, market}, state) do
    {channel, text} = build_daily_summary(market)
    do_send(channel, text)
    {:noreply, %{state | sent: state.sent + 1}}
  end

  def handle_cast({:weekly_summary, market}, state) do
    {channel, text} = build_weekly_summary(market)
    do_send(channel, text)
    {:noreply, %{state | sent: state.sent + 1}}
  end

  # ─── Internal ────────────────────────────────────────────────────

  defp do_send(channel, message) do
    hub_url   = System.get_env("HUB_BASE_URL", "http://localhost:7788")
    hub_token = System.get_env("HUB_AUTH_TOKEN", "")

    case Req.post("#{hub_url}/hub/telegram/send",
           json: %{channel: to_string(channel), message: message},
           headers: [{"Authorization", "Bearer #{hub_token}"}],
           receive_timeout: 10_000) do
      {:ok, %Req.Response{status: 200}} ->
        Logger.debug("[TelegramReporter] #{channel} 전송 완료")
        :ok
      err ->
        Logger.warning("[TelegramReporter] #{channel} 전송 실패: #{inspect(err)}")
        :error
    end
  rescue
    e ->
      Logger.error("[TelegramReporter] 예외: #{inspect(e)}")
      :error
  end

  defp build_daily_summary(market) do
    channel = market_channel(market)
    pnl     = fetch_daily_pnl(market)
    llm_cost = fetch_llm_cost_24h()
    rag_quality = fetch_rag_quality_24h()

    text = """
    📊 [루나] #{market} 일일 리포트
    PnL 24h: #{format_pnl(pnl)}
    LLM 비용: $#{Float.round(llm_cost, 4)}
    RAG 품질: #{Float.round(rag_quality, 3)}
    #{DateTime.utc_now() |> DateTime.add(9 * 3600, :second) |> Calendar.strftime("%Y-%m-%d %H:%M KST")}
    """
    {channel, text}
  end

  defp build_weekly_summary(market) do
    channel = market_channel(market)
    pnl_7d  = fetch_weekly_pnl(market)
    promotions = fetch_strategy_promotions_7d()
    demotions  = fetch_strategy_demotions_7d()

    text = """
    📈 [루나] #{market} 주간 리포트
    PnL 7일: #{format_pnl(pnl_7d)}
    전략 승격: #{promotions}건 | 강등: #{demotions}건
    #{DateTime.utc_now() |> DateTime.add(9 * 3600, :second) |> Calendar.strftime("%Y-%m-%d KST")}
    """
    {channel, text}
  end

  defp market_channel(:crypto),   do: :luna_crypto
  defp market_channel(:domestic), do: :luna_domestic
  defp market_channel(:overseas), do: :luna_overseas
  defp market_channel(_),         do: :general

  defp format_pnl(nil), do: "N/A"
  defp format_pnl(pnl) when pnl >= 0, do: "+#{Float.round(pnl * 100, 2)}%"
  defp format_pnl(pnl), do: "#{Float.round(pnl * 100, 2)}%"

  defp fetch_daily_pnl(market) do
    sql = """
    SELECT COALESCE(AVG(pnl_pct), 0) FROM investment.trade_history
    WHERE market = $1 AND closed_at > NOW() - INTERVAL '24 hours'
    """
    case Jay.Core.Repo.query(sql, [to_string(market)]) do
      {:ok, %{rows: [[v | _] | _]}} when is_number(v) -> v
      _ -> nil
    end
  rescue
    _ -> nil
  end

  defp fetch_llm_cost_24h do
    sql = """
    SELECT COALESCE(SUM(cost_usd), 0) FROM investment_llm_routing_log
    WHERE created_at > NOW() - INTERVAL '24 hours'
    """
    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[v | _] | _]}} when is_number(v) -> v
      _ -> 0.0
    end
  rescue
    _ -> 0.0
  end

  defp fetch_rag_quality_24h do
    sql = """
    SELECT COALESCE(AVG((metrics->>'quality')::float), 0)
    FROM luna_strategy_validation_runs
    WHERE created_at > NOW() - INTERVAL '24 hours'
    """
    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[v | _] | _]}} when is_number(v) -> v
      _ -> 0.0
    end
  rescue
    _ -> 0.0
  end

  defp fetch_weekly_pnl(market) do
    sql = """
    SELECT COALESCE(AVG(pnl_pct), 0) FROM investment.trade_history
    WHERE market = $1 AND closed_at > NOW() - INTERVAL '7 days'
    """
    case Jay.Core.Repo.query(sql, [to_string(market)]) do
      {:ok, %{rows: [[v | _] | _]}} when is_number(v) -> v
      _ -> nil
    end
  rescue
    _ -> nil
  end

  defp fetch_strategy_promotions_7d do
    sql = """
    SELECT COUNT(*) FROM luna_strategy_validation_runs
    WHERE verdict->>'verdict' = 'promote' AND created_at > NOW() - INTERVAL '7 days'
    """
    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[n | _] | _]}} -> n
      _ -> 0
    end
  rescue
    _ -> 0
  end

  defp fetch_strategy_demotions_7d do
    sql = """
    SELECT COUNT(*) FROM luna_strategy_validation_runs
    WHERE verdict->>'verdict' = 'demote' AND created_at > NOW() - INTERVAL '7 days'
    """
    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[n | _] | _]}} -> n
      _ -> 0
    end
  rescue
    _ -> 0
  end
end
