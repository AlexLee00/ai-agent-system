defmodule TeamJay.Ska.Pickko.PickkoParser do
  @moduledoc """
  픽코 주문/결제 데이터 파싱/정규화 모듈

  Phase 1 역할:
    - Node.js PortAgent가 반환한 픽코 JSON 데이터 정규화
    - 주문 상태 분류: :paid | :pending | :cancelled | :refunded
    - 결제 수단 분류: :card | :cash | :mobile | :pass
    - 데이터 유효성 검증 및 누락 필드 기본값 처리
  """

  require Logger

  # ─── Public API ──────────────────────────────────────────

  @doc """
  픽코 주문 목록 파싱

  반환: {:ok, [order]} | {:error, reason}
  """
  def parse_order_list(raw) when is_list(raw) do
    results = Enum.map(raw, &parse_single_order/1)
    valid = Enum.flat_map(results, fn
      {:ok, o} -> [o]
      {:error, reason} ->
        Logger.warning("[PickkoParser] 주문 파싱 실패: #{inspect(reason)}")
        []
    end)
    {:ok, valid}
  end

  def parse_order_list(_), do: {:error, :invalid_input}

  @doc "단일 주문 파싱"
  def parse_single_order(raw) when is_map(raw) do
    with {:ok, order_id} <- extract_field(raw, "order_id"),
         {:ok, status_str} <- extract_field(raw, "status"),
         {:ok, status} <- classify_order_status(status_str) do
      {:ok, %{
        order_id: order_id,
        member_name: Map.get(raw, "member_name") || Map.get(raw, "name"),
        member_phone: Map.get(raw, "member_phone") || Map.get(raw, "phone"),
        room: Map.get(raw, "room"),
        date: Map.get(raw, "date"),
        start_time: Map.get(raw, "start_time"),
        end_time: Map.get(raw, "end_time"),
        amount: parse_amount(Map.get(raw, "amount")),
        payment_method: classify_payment(Map.get(raw, "payment_method")),
        status: status,
        raw_status: status_str,
        parsed_at: DateTime.utc_now()
      }}
    end
  end

  def parse_single_order(_), do: {:error, :invalid_order}

  @doc "주문 상태 분류"
  def classify_order_status(str) when is_binary(str) do
    cond do
      String.contains?(str, ["결제완료", "paid", "완료"]) -> {:ok, :paid}
      String.contains?(str, ["대기", "pending", "미결제"]) -> {:ok, :pending}
      String.contains?(str, ["취소", "cancel", "cancelled"]) -> {:ok, :cancelled}
      String.contains?(str, ["환불", "refund", "refunded"]) -> {:ok, :refunded}
      true ->
        Logger.warning("[PickkoParser] 미분류 주문 상태: #{str}")
        {:ok, :unknown}
    end
  end

  def classify_order_status(_), do: {:error, :invalid_status}

  @doc "결제 수단 분류"
  def classify_payment(str) when is_binary(str) do
    cond do
      String.contains?(str, ["카드", "card", "신용"]) -> :card
      String.contains?(str, ["현금", "cash"]) -> :cash
      String.contains?(str, ["모바일", "mobile", "간편결제", "카카오", "네이버페이"]) -> :mobile
      String.contains?(str, ["이용권", "pass", "정기"]) -> :pass
      true -> :unknown
    end
  end

  def classify_payment(_), do: :unknown

  @doc "결제 금액 파싱 (문자열 → 정수)"
  def parse_amount(nil), do: 0
  def parse_amount(n) when is_integer(n), do: n
  def parse_amount(str) when is_binary(str) do
    str
    |> String.replace(~r/[^0-9]/, "")
    |> Integer.parse()
    |> case do
      {n, _} -> n
      :error -> 0
    end
  end
  def parse_amount(_), do: 0

  @doc "결제 완료 주문만 필터링"
  def filter_paid(orders), do: Enum.filter(orders, &(&1.status == :paid))

  @doc "오늘 날짜 주문만 필터링"
  def filter_today(orders) do
    today = Date.utc_today() |> Date.to_string()
    Enum.filter(orders, &(Map.get(&1, :date) == today))
  end

  # ─── Private ─────────────────────────────────────────────

  defp extract_field(map, key) do
    case Map.get(map, key) || Map.get(map, String.to_atom(key)) do
      nil -> {:error, {:missing_field, key}}
      val -> {:ok, val}
    end
  end
end
