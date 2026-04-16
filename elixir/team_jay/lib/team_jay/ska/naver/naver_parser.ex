defmodule TeamJay.Ska.Naver.NaverParser do
  @moduledoc """
  네이버 예약 데이터 파싱/분류 모듈

  Phase 1 역할:
    - Node.js PortAgent가 반환한 JSON 예약 데이터 정규화
    - 예약 상태 분류: :new | :confirmed | :cancelled | :pending | :no_show
    - 예약 데이터 유효성 검증
    - ParsingGuard에 파싱 결과 보고

  Node.js(Playwright)가 HTML을 파싱하고 JSON을 반환하면,
  이 모듈이 해당 JSON을 Elixir 구조체로 변환/검증합니다.
  """

  require Logger

  # ─── Public API ──────────────────────────────────────────

  @doc """
  PortAgent JSON 결과 → 예약 목록 파싱

  반환: {:ok, [booking]} | {:error, reason}
  """
  def parse_booking_list(raw) when is_list(raw) do
    results = Enum.map(raw, &parse_single_booking/1)
    errors = Enum.filter(results, &match?({:error, _}, &1))

    if Enum.empty?(errors) do
      bookings = Enum.map(results, fn {:ok, b} -> b end)
      {:ok, bookings}
    else
      # 일부 실패는 경고만, 성공분은 반환
      valid = Enum.flat_map(results, fn
        {:ok, b} -> [b]
        _ -> []
      end)
      Logger.warning("[NaverParser] #{length(errors)}/#{length(raw)} 파싱 실패")
      {:ok, valid}
    end
  end

  def parse_booking_list(_), do: {:error, :invalid_input}

  @doc "단일 예약 파싱"
  def parse_single_booking(raw) when is_map(raw) do
    with {:ok, booking_id} <- extract_field(raw, "booking_id"),
         {:ok, guest_name} <- extract_field(raw, "guest_name"),
         {:ok, status_str} <- extract_field(raw, "status"),
         {:ok, status}     <- classify_status(status_str) do
      {:ok, %{
        booking_id: booking_id,
        guest_name: guest_name,
        guest_phone: Map.get(raw, "guest_phone"),
        date: Map.get(raw, "date"),
        host: Map.get(raw, "host"),
        status: status,
        raw_status: status_str,
        parsed_at: DateTime.utc_now()
      }}
    end
  end

  def parse_single_booking(_), do: {:error, :invalid_booking}

  @doc "예약 상태 문자열 → atom 분류"
  def classify_status(str) when is_binary(str) do
    cond do
      String.contains?(str, ["신규", "new", "예약접수"]) -> {:ok, :new}
      String.contains?(str, ["확정", "confirmed", "승인"]) -> {:ok, :confirmed}
      String.contains?(str, ["취소", "cancel", "cancelled"]) -> {:ok, :cancelled}
      String.contains?(str, ["노쇼", "no_show", "불참"]) -> {:ok, :no_show}
      String.contains?(str, ["대기", "pending", "처리중"]) -> {:ok, :pending}
      true ->
        Logger.warning("[NaverParser] 미분류 상태: #{str}")
        {:ok, :unknown}
    end
  end

  def classify_status(_), do: {:error, :invalid_status}

  @doc "예약 목록에서 상태별 분류"
  def group_by_status(bookings) when is_list(bookings) do
    Enum.group_by(bookings, & &1.status)
  end

  @doc "취소된 예약 필터링"
  def filter_cancelled(bookings) do
    Enum.filter(bookings, &(&1.status == :cancelled))
  end

  @doc "신규 예약 필터링"
  def filter_new(bookings) do
    Enum.filter(bookings, &(&1.status == :new))
  end

  # ─── Private ─────────────────────────────────────────────

  defp extract_field(map, key) do
    case Map.get(map, key) || Map.get(map, String.to_atom(key)) do
      nil -> {:error, {:missing_field, key}}
      val -> {:ok, val}
    end
  end
end
