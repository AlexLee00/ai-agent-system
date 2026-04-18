defmodule TeamJay.Ska.Rag.QualityEvaluatorTest do
  use ExUnit.Case, async: true
  alias TeamJay.Ska.Rag.QualityEvaluator

  describe "score/2" do
    test "빈 문서 목록 처리" do
      assert {:ok, []} = QualityEvaluator.score([], %{agent: :andy})
    end

    test "문서에 final_score 부여" do
      docs = [
        %{source: :failure_library, content: "andy 파싱 실패 복구", score: 0.8},
        %{source: :cross_team, content: "다른 팀 이슈", score: 0.4}
      ]

      assert {:ok, scored} = QualityEvaluator.score(docs, %{agent: :andy, error: :parse_failed})
      assert length(scored) == 2
      assert Enum.all?(scored, fn d -> Map.has_key?(d, :final_score) end)
    end

    test "failure_library 소스가 cross_team보다 높은 신뢰도" do
      docs = [
        %{source: :failure_library, content: "내용", score: 0.5},
        %{source: :cross_team, content: "내용", score: 0.5}
      ]

      {:ok, scored} = QualityEvaluator.score(docs, %{agent: :andy})
      fl = Enum.find(scored, &(&1.source == :failure_library))
      ct = Enum.find(scored, &(&1.source == :cross_team))
      assert fl.final_score > ct.final_score
    end

    test "관련 키워드 포함 시 relevance 상승" do
      docs = [
        %{source: :failure_library, content: "andy 세션 만료 복구", score: 0.5},
        %{source: :failure_library, content: "jimmy 키오스크 오류", score: 0.5}
      ]

      {:ok, scored} = QualityEvaluator.score(docs, %{agent: :andy, error: :session_expired})
      andy_doc = Enum.find(scored, fn d -> String.contains?(d.content, "andy") end)
      jimmy_doc = Enum.find(scored, fn d -> String.contains?(d.content, "jimmy") end)
      assert andy_doc.relevance >= jimmy_doc.relevance
    end
  end

  describe "needs_retry?/1" do
    test "빈 목록은 retry 필요" do
      assert QualityEvaluator.needs_retry?([]) == true
    end

    test "높은 점수는 retry 불필요" do
      docs = [%{final_score: 0.9}, %{final_score: 0.85}]
      assert QualityEvaluator.needs_retry?(docs) == false
    end

    test "낮은 점수는 retry 필요" do
      docs = [%{final_score: 0.3}, %{final_score: 0.2}]
      assert QualityEvaluator.needs_retry?(docs) == true
    end
  end
end
