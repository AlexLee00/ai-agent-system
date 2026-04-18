defmodule TeamJay.Ska.Rag.QueryPlanner do
  @moduledoc """
  실패 상황을 검색 가능한 서브쿼리로 분해.

  입력: failure_context = %{agent: :andy, error: :parse_failed, message: "...", ...}
  출력: [{:ok, [subquery, ...]}]
  """
  require Logger

  @doc """
  실패 컨텍스트를 서브쿼리 목록으로 분해.
  """
  def decompose(failure_context) do
    agent = failure_context[:agent] || :unknown
    error = failure_context[:error] || failure_context[:error_type] || :unknown
    message = failure_context[:message] || ""

    subqueries = [
      %{type: :agent, value: agent, weight: 0.4},
      %{type: :error_class, value: classify_error(error, message), weight: 0.3},
      %{type: :symptom, value: extract_symptoms(failure_context), weight: 0.2},
      %{type: :temporal, value: recent_time_window(), weight: 0.1}
    ]

    Logger.debug("[QueryPlanner] #{agent} 실패 → #{length(subqueries)}개 서브쿼리")
    {:ok, subqueries}
  end

  # ─── 내부 ────────────────────────────────────────────────

  defp classify_error(error, message) do
    cond do
      error in [:session_expired, :auth_failed] or String.contains?(message, "로그인") ->
        :session_expiry

      error in [:parse_failed, :selector_failed] or String.contains?(message, "parse") ->
        :selector_parse_failure

      error in [:db_disconnect, :db_error] or String.contains?(message, "DB") ->
        :database_error

      error in [:timeout, :network_error] or String.contains?(message, "timeout") ->
        :network_timeout

      error in [:kiosk_frozen, :kiosk_offline] ->
        :kiosk_hardware_issue

      true ->
        :unknown_error
    end
  end

  defp extract_symptoms(context) do
    symptoms = []
    symptoms = if context[:consecutive_failures], do: [:consecutive_failures | symptoms], else: symptoms
    symptoms = if context[:selector_version], do: [:selector_version_mismatch | symptoms], else: symptoms
    symptoms = if context[:response_size] && context[:response_size] < 500, do: [:short_response | symptoms], else: symptoms
    symptoms
  end

  defp recent_time_window do
    now = DateTime.utc_now()
    %{from: DateTime.add(now, -7 * 24 * 3600, :second), to: now}
  end
end
