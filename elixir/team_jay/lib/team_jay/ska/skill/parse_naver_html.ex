defmodule TeamJay.Ska.Skill.ParseNaverHtml do
  @moduledoc """
  네이버 스마트플레이스 예약 HTML 파싱 스킬 — Andy 전용.

  기존 NaverParser 로직을 스킬로 래핑 + SelectorManager 결과 기록.
  현재 NaverParser는 PortAgent가 정규화한 예약 JSON(list)을 입력으로 받는다.

  입력: %{raw: [...]} 또는 %{html: [...]} (legacy 호환)
  출력: {:ok, %{bookings: [...], parsed_count: n, selector_used: "v3", fallback: false}}
  """

  @behaviour TeamJay.Ska.Skill

  @impl true
  def metadata do
    %{
      name: :parse_naver_html,
      domain: :naver,
      version: "1.0",
      description: "네이버 예약 목록 원본 데이터를 예약 목록으로 정규화",
      input_schema: %{raw: :list, target: :string},
      output_schema: %{bookings: :list, parsed_count: :integer, selector_used: :string}
    }
  end

  @impl true
  def run(params, _context) do
    raw = params[:raw] || params[:html] || []
    target = params[:target] || "naver_list"
    selectors = TeamJay.Ska.SelectorManager.get_active(target)
    selector = List.first(selectors)

    case TeamJay.Ska.Naver.NaverParser.parse_booking_list(raw) do
      {:ok, bookings} ->
        record_selector_result(selector, true)

        {:ok,
         %{
           bookings: bookings,
           parsed_count: length(bookings),
           selector_used: selector_version(selector),
           fallback: false
         }}

      {:error, reason} ->
        record_selector_result(selector, false)
        TeamJay.Ska.SelectorManager.invalidate_cache(target)
        {:error, {:parse_failed, reason}}
    end
  end

  defp record_selector_result(nil, _success?), do: :ok

  defp record_selector_result(selector, success?) do
    TeamJay.Ska.SelectorManager.record_result(selector.id, success?)
  end

  defp selector_version(nil), do: "selector_unavailable"
  defp selector_version(selector), do: selector.version || "unknown"
end
