defmodule Luna.V2.Rag.QualityEvaluatorTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Rag.QualityEvaluator

  defp doc(category, similarity) do
    %{"category" => category, "similarity" => similarity, "content" => "test"}
  end

  describe "score/2" do
    test "빈 리스트 → 0.0" do
      assert QualityEvaluator.score([]) == 0.0
    end

    test "단일 문서 → 0.0보다 크고 1.0 이하" do
      score = QualityEvaluator.score([doc("trade_review", 0.9)])
      assert score > 0.0
      assert score <= 1.0
    end

    test "10개 문서 다양한 카테고리 → 높은 점수" do
      docs = [
        doc("trade_review", 0.9),
        doc("thesis", 0.8),
        doc("failure_case", 0.85),
        doc("news_memo", 0.7),
        doc("regime_shift", 0.75),
        doc("analyst_insight", 0.8),
        doc("trade_review", 0.7),
        doc("thesis", 0.65),
        doc("failure_case", 0.6),
        doc("news_memo", 0.9)
      ]
      score = QualityEvaluator.score(docs)
      assert score >= 0.7
    end

    test "카테고리 1종만 → 다양성 점수 낮음" do
      docs = Enum.map(1..5, fn _ -> doc("trade_review", 0.8) end)
      single_cat = QualityEvaluator.score(docs)

      diverse_docs = [
        doc("trade_review", 0.8), doc("thesis", 0.8), doc("failure_case", 0.8)
      ]
      diverse = QualityEvaluator.score(diverse_docs)

      assert diverse > single_cat
    end

    test "결과는 항상 0.0~1.0 범위" do
      docs = Enum.map(1..20, fn _ -> doc("trade_review", 1.0) end)
      score = QualityEvaluator.score(docs)
      assert score >= 0.0
      assert score <= 1.0
    end
  end

  describe "sufficient?/2" do
    test "품질 높은 docs → true" do
      docs = [
        doc("trade_review", 0.95),
        doc("thesis", 0.90),
        doc("failure_case", 0.85),
        doc("news_memo", 0.80),
        doc("regime_shift", 0.85),
        doc("analyst_insight", 0.90)
      ]
      assert QualityEvaluator.sufficient?(docs)
    end

    test "빈 리스트 → false" do
      refute QualityEvaluator.sufficient?([])
    end
  end

  test "threshold/0 → 0.7" do
    assert QualityEvaluator.threshold() == 0.7
  end
end
