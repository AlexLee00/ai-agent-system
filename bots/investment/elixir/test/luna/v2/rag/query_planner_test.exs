defmodule Luna.V2.Rag.QueryPlannerTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Rag.QueryPlanner

  describe "decompose/2 — 규칙 기반 fallback (Hub 미연결 환경)" do
    test "단순 쿼리 → 2개 이상 서브쿼리" do
      subqueries = QueryPlanner.decompose("BTC 3만달러 돌파")
      assert is_list(subqueries)
      assert length(subqueries) >= 2
    end

    test "원본 쿼리 포함됨" do
      query = "ETH 롱 포지션 사례"
      subqueries = QueryPlanner.decompose(query)
      assert Enum.member?(subqueries, query)
    end

    test "category 컨텍스트 있으면 카테고리 특화 쿼리 추가" do
      subqueries = QueryPlanner.decompose("BTC 상승", %{category: "failure_case"})
      assert Enum.any?(subqueries, fn q -> String.contains?(q, "failure_case") end)
    end

    test "symbol 컨텍스트 있으면 심볼 특화 쿼리 추가" do
      subqueries = QueryPlanner.decompose("급등 패턴", %{symbol: "AAPL"})
      assert Enum.any?(subqueries, fn q -> String.contains?(q, "AAPL") end)
    end

    test "중복 없음" do
      subqueries = QueryPlanner.decompose("동일 쿼리")
      assert subqueries == Enum.uniq(subqueries)
    end
  end
end
