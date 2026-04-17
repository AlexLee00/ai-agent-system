defmodule Darwin.V2.ShadowCompareTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.ShadowCompare

  setup_all do
    Code.ensure_loaded?(Darwin.V2.ShadowCompare)
    :ok
  end

  describe "module_definition" do
    test "ShadowCompare 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(ShadowCompare)
    end
  end

  describe "public_api" do
    test "jaccard_similarity/2 함수 export" do
      assert function_exported?(ShadowCompare, :jaccard_similarity, 2)
    end

    test "score_match?/3 함수 export" do
      assert function_exported?(ShadowCompare, :score_match?, 3)
    end

    test "compare/2 함수 export" do
      assert function_exported?(ShadowCompare, :compare, 2)
    end

    test "aggregate_runs/1 함수 export" do
      assert function_exported?(ShadowCompare, :aggregate_runs, 1)
    end
  end

  describe "jaccard_similarity" do
    test "동일 집합은 1.0" do
      result = ShadowCompare.jaccard_similarity(MapSet.new([1, 2, 3]), MapSet.new([1, 2, 3]))
      assert result == 1.0
    end

    test "서로소 집합은 0.0" do
      result = ShadowCompare.jaccard_similarity(MapSet.new([1]), MapSet.new([2]))
      assert result == 0.0
    end
  end

  describe "score_match" do
    test "동일 점수는 match" do
      assert ShadowCompare.score_match?(5.0, 5.0, 1.0)
    end

    test "tolerance 초과는 non-match" do
      refute ShadowCompare.score_match?(5.0, 7.0, 1.0)
    end
  end

  describe "aggregate_runs" do
    test "빈 리스트는 기본값 반환" do
      result = ShadowCompare.aggregate_runs([])
      assert result.avg_match == 0.0
      assert result.promotion_ready == false
    end
  end
end
