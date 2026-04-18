defmodule TeamJay.Ska.Skill.ParseNaverHtml do
  @moduledoc """
  네이버 스마트플레이스 예약 HTML 파싱 스킬 — Andy 전용.

  기존 NaverParser 로직을 스킬로 래핑 + SelectorManager 통합.
  파싱 실패 시 SelectorManager fallback 셀렉터 자동 시도.

  입력: %{html: "...", selectors_version: "latest"}
  출력: {:ok, %{bookings: [...], parsed_count: n, selector_used: "v3", fallback: false}}
  """

  @behaviour TeamJay.Ska.Skill

  @impl true
  def metadata do
    %{
      name: :parse_naver_html,
      domain: :naver,
      version: "1.0",
      description: "네이버 예약 페이지 HTML을 예약 목록으로 파싱",
      input_schema: %{html: :string, selectors_version: :string},
      output_schema: %{bookings: :list, parsed_count: :integer, selector_used: :string}
    }
  end

  @impl true
  def run(params, _context) do
    html = params[:html] || ""

    with {:ok, selectors} <- TeamJay.Ska.SelectorManager.get_active(:andy) do
      case TeamJay.Ska.Naver.NaverParser.parse_booking_list(html, selectors) do
        {:ok, bookings} ->
          TeamJay.Ska.SelectorManager.record_success(:andy, selectors.version)
          {:ok, %{
            bookings: bookings,
            parsed_count: length(bookings),
            selector_used: selectors.version,
            fallback: false
          }}

        {:error, :parse_failed} ->
          TeamJay.Ska.SelectorManager.record_failure(:andy, selectors.version)
          try_fallback(html)
      end
    end
  end

  defp try_fallback(html) do
    case TeamJay.Ska.SelectorManager.try_fallback(:andy) do
      {:ok, fallback_selectors} ->
        case TeamJay.Ska.Naver.NaverParser.parse_booking_list(html, fallback_selectors) do
          {:ok, bookings} ->
            {:ok, %{
              bookings: bookings,
              parsed_count: length(bookings),
              selector_used: fallback_selectors.version,
              fallback: true
            }}

          {:error, reason} ->
            {:error, {:parse_failed, reason}}
        end

      {:error, :no_fallback} ->
        {:error, {:parse_failed, "all_selectors_exhausted"}}
    end
  end
end
