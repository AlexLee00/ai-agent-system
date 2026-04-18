defmodule TeamJay.Ska.Rag.QueryPlannerTest do
  use ExUnit.Case, async: true
  alias TeamJay.Ska.Rag.QueryPlanner

  describe "decompose/1" do
    test "서브쿼리 4개 반환" do
      context = %{agent: :andy, error: :parse_failed, message: "셀렉터 CSS 변경"}
      assert {:ok, subqueries} = QueryPlanner.decompose(context)
      assert length(subqueries) == 4
    end

    test "agent 서브쿼리 포함" do
      context = %{agent: :jimmy, error: :kiosk_frozen}
      {:ok, subqueries} = QueryPlanner.decompose(context)
      agent_q = Enum.find(subqueries, &(&1.type == :agent))
      assert agent_q.value == :jimmy
    end

    test "세션 만료 에러 → session_expiry 분류" do
      context = %{agent: :andy, error: :session_expired, message: ""}
      {:ok, subqueries} = QueryPlanner.decompose(context)
      error_q = Enum.find(subqueries, &(&1.type == :error_class))
      assert error_q.value == :session_expiry
    end

    test "로그인 메시지 → session_expiry 분류" do
      context = %{agent: :andy, error: :unknown, message: "로그인이 필요합니다"}
      {:ok, subqueries} = QueryPlanner.decompose(context)
      error_q = Enum.find(subqueries, &(&1.type == :error_class))
      assert error_q.value == :session_expiry
    end

    test "파싱 에러 → selector_parse_failure 분류" do
      context = %{agent: :andy, error: :parse_failed, message: ""}
      {:ok, subqueries} = QueryPlanner.decompose(context)
      error_q = Enum.find(subqueries, &(&1.type == :error_class))
      assert error_q.value == :selector_parse_failure
    end

    test "알 수 없는 에러 → unknown_error 분류" do
      context = %{agent: :andy, error: :mysterious_error, message: ""}
      {:ok, subqueries} = QueryPlanner.decompose(context)
      error_q = Enum.find(subqueries, &(&1.type == :error_class))
      assert error_q.value == :unknown_error
    end
  end
end
