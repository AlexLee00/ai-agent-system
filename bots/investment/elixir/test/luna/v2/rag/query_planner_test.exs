defmodule Luna.V2.Rag.QueryPlannerTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Rag.QueryPlanner

  describe "decompose/2 — 구조 검증 (LLM 연결 여부 무관)" do
    test "결과는 리스트" do
      result = QueryPlanner.decompose("BTC 3만달러 돌파")
      assert is_list(result)
    end

    test "2개 이상 서브쿼리 반환" do
      subqueries = QueryPlanner.decompose("ETH 롱 포지션 사례")
      assert length(subqueries) >= 2
    end

    test "모든 서브쿼리는 비어있지 않은 string" do
      subqueries = QueryPlanner.decompose("AAPL 급등 패턴 분석")
      assert Enum.all?(subqueries, fn q -> is_binary(q) and String.length(q) > 0 end)
    end

    test "중복 없음" do
      subqueries = QueryPlanner.decompose("동일 쿼리")
      assert subqueries == Enum.uniq(subqueries)
    end

    test "최대 5개 이하 (과도한 분해 방지)" do
      subqueries = QueryPlanner.decompose("복잡한 투자 분석 쿼리")
      assert length(subqueries) <= 5
    end
  end
end
