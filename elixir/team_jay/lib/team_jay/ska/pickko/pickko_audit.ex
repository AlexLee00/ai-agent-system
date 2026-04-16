defmodule TeamJay.Ska.Pickko.PickkoAudit do
  @moduledoc """
  픽코 일일 감사 GenServer

  Phase 1 역할:
    - 매일 자정 픽코 주문/결제 일일 정산 검증
    - 키오스크 차단 슬롯 vs 실제 예약 정합성 체크
    - 이상 거래 감지 (금액 불일치, 중복 예약 등)
    - 감사 결과 → EventLake + 텔레그램 알림

  PortAgent(:pickko_daily_audit) 실행 후 결과를 수신하여
  Elixir 레이어에서 추가 검증을 수행합니다.
  """

  use GenServer
  require Logger

  @daily_audit_hour 1  # 새벽 1시 감사 실행

  defstruct [
    :last_audit_at,
    :last_audit_result,
    :audit_history
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "최근 감사 결과 조회"
  def get_last_audit do
    GenServer.call(__MODULE__, :get_last_audit)
  end

  @doc "감사 완료 보고 (PortAgent 또는 수동 트리거)"
  def report_audit_result(result) when is_map(result) do
    GenServer.cast(__MODULE__, {:audit_result, result})
  end

  @doc "수동 감사 트리거"
  def trigger_audit do
    GenServer.cast(__MODULE__, :run_audit)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[PickkoAudit] 시작! 일일 감사 스케줄")
    schedule_daily_audit()

    {:ok, %__MODULE__{
      last_audit_at: nil,
      last_audit_result: nil,
      audit_history: []
    }}
  end

  @impl true
  def handle_cast({:audit_result, result}, state) do
    anomalies = detect_anomalies(result)
    enriched = Map.merge(result, %{
      anomalies: anomalies,
      audit_ok: Enum.empty?(anomalies),
      audited_at: DateTime.utc_now()
    })

    if Enum.empty?(anomalies) do
      Logger.info("[PickkoAudit] 감사 완료 — 이상 없음")
    else
      Logger.warning("[PickkoAudit] 감사 완료 — 이상 #{length(anomalies)}건")
      notify_anomalies(anomalies)
    end

    TeamJay.EventLake.record(%{
      event_type: "ska_pickko_audit",
      team: "ska",
      bot_name: "pickko_audit",
      severity: (if Enum.empty?(anomalies), do: "info", else: "warning"),
      title: "픽코 일일 감사",
      message: inspect(enriched),
      tags: ["pickko", "audit", "daily"]
    })

    history = Enum.take([enriched | state.audit_history], 30)
    {:noreply, %{state |
      last_audit_at: DateTime.utc_now(),
      last_audit_result: enriched,
      audit_history: history
    }}
  end

  @impl true
  def handle_cast(:run_audit, state) do
    Logger.info("[PickkoAudit] 수동 감사 트리거")
    TeamJay.Ska.PubSub.broadcast(:audit_requested, %{agent: "jimmy", type: :daily})
    {:noreply, state}
  end

  @impl true
  def handle_info(:daily_audit, state) do
    schedule_daily_audit()
    Logger.info("[PickkoAudit] 일일 감사 시작")
    GenServer.cast(self(), :run_audit)
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_last_audit, _from, state) do
    {:reply, state.last_audit_result, state}
  end

  # ─── Private: 이상 감지 ───────────────────────────────────

  defp detect_anomalies(result) do
    []
    |> check_payment_mismatch(result)
    |> check_duplicate_bookings(result)
    |> check_blocked_slot_mismatch(result)
  end

  defp check_payment_mismatch(acc, result) do
    total_orders = Map.get(result, :total_orders, 0)
    paid_orders = Map.get(result, :paid_orders, 0)
    total_amount = Map.get(result, :total_amount, 0)
    expected_amount = Map.get(result, :expected_amount, 0)

    cond do
      total_amount != expected_amount and expected_amount > 0 ->
        [{:payment_mismatch, %{total: total_amount, expected: expected_amount}} | acc]
      paid_orders > total_orders ->
        [{:paid_exceeds_orders, %{paid: paid_orders, total: total_orders}} | acc]
      true -> acc
    end
  end

  defp check_duplicate_bookings(acc, result) do
    duplicates = Map.get(result, :duplicate_booking_ids, [])
    if Enum.empty?(duplicates) do
      acc
    else
      [{:duplicate_bookings, %{ids: duplicates}} | acc]
    end
  end

  defp check_blocked_slot_mismatch(acc, result) do
    blocked = Map.get(result, :blocked_slots, 0)
    actual_blocked = Map.get(result, :actual_blocked_in_naver, 0)
    if blocked != actual_blocked and actual_blocked > 0 do
      [{:slot_mismatch, %{recorded: blocked, actual: actual_blocked}} | acc]
    else
      acc
    end
  end

  defp notify_anomalies(anomalies) do
    anomaly_text = Enum.map_join(anomalies, "\n", fn {type, data} ->
      "⚠️ #{type}: #{inspect(data)}"
    end)

    TeamJay.HubClient.post_alarm(
      "🔍 픽코 감사 이상 감지!\n#{anomaly_text}",
      "ska", "pickko_audit"
    )
  end

  defp schedule_daily_audit do
    # 다음 새벽 1시까지의 ms 계산
    now = DateTime.utc_now()
    target_hour = @daily_audit_hour
    next_run =
      if now.hour < target_hour do
        %{now | hour: target_hour, minute: 0, second: 0, microsecond: {0, 0}}
      else
        DateTime.add(now, 86_400, :second)
        |> Map.put(:hour, target_hour)
        |> Map.put(:minute, 0)
        |> Map.put(:second, 0)
      end

    delay_ms = max(DateTime.diff(next_run, now, :millisecond), 60_000)
    Process.send_after(self(), :daily_audit, delay_ms)
  end
end
