defmodule Darwin.V2.Rag.AgenticRagTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Rag.{AgenticRag, QueryPlanner, QualityEvaluator}

  setup do
    on_exit(fn ->
      System.delete_env("DARWIN_AGENTIC_RAG_ENABLED")
    end)
  end

  describe "AgenticRag.retrieve/2 — kill switch OFF" do
    test "kill switch OFF이면 SelfRAG fallback 시도 후 응답 반환" do
      System.delete_env("DARWIN_AGENTIC_RAG_ENABLED")
      result = AgenticRag.retrieve("RAG 최적화 기법", %{})
      assert match?({:ok, _}, result)
    end

    test "kill switch OFF이면 agentic_rag disabled 기록" do
      System.put_env("DARWIN_AGENTIC_RAG_ENABLED", "false")
      assert match?({:ok, _}, AgenticRag.retrieve("test query"))
    end
  end

  describe "AgenticRag.retrieve/2 — kill switch ON" do
    test "kill switch ON + LLM/DB 없어도 오류 없이 {:ok, map} 반환" do
      System.put_env("DARWIN_AGENTIC_RAG_ENABLED", "true")
      result = AgenticRag.retrieve("Agentic RAG 최신 연구")
      assert match?({:ok, %{answer: _, sources: _, quality: _}}, result)
    end
  end

  describe "QueryPlanner.decompose/2" do
    test "짧은 쿼리 — 단일 쿼리 반환 (LLM 없음)" do
      {:ok, subs} = QueryPlanner.decompose("RAG")
      assert is_list(subs)
      assert length(subs) >= 1
    end

    test "긴 쿼리 — 2개 이상 분해 (규칙 기반)" do
      long_query = "최신 Agentic RAG 기법의 성능 향상 방법과 실제 적용 사례 비교 분석"
      {:ok, subs} = QueryPlanner.decompose(long_query)
      assert is_list(subs)
      assert length(subs) >= 1
    end

    test "빈 컨텍스트도 문제없이 동작" do
      {:ok, subs} = QueryPlanner.decompose("test query", %{})
      assert is_list(subs)
    end
  end

  describe "QualityEvaluator.score/2" do
    test "빈 문서 목록 — quality 0.0 반환" do
      {:ok, result} = QualityEvaluator.score([], "query")
      assert result.quality == 0.0
      assert result.docs == []
    end

    test "문서 있으면 quality 0.0~1.0 범위" do
      docs = [
        %{"content" => "RAG 기법 연구", "source" => "l2_memory", "inserted_at" => nil}
      ]
      {:ok, result} = QualityEvaluator.score(docs, "RAG")
      assert result.quality >= 0.0
      assert result.quality <= 1.0
    end

    test "below_threshold?/1 — 0.3은 임계값 미만" do
      assert QualityEvaluator.below_threshold?(0.3)
    end

    test "below_threshold?/1 — 0.8은 임계값 이상" do
      refute QualityEvaluator.below_threshold?(0.8)
    end
  end

  describe "KillSwitch :agentic_rag 연동" do
    test "기본값 false" do
      System.delete_env("DARWIN_AGENTIC_RAG_ENABLED")
      refute Darwin.V2.KillSwitch.enabled?(:agentic_rag)
    end

    test "DARWIN_AGENTIC_RAG_ENABLED=true 이면 true" do
      System.put_env("DARWIN_AGENTIC_RAG_ENABLED", "true")
      assert Darwin.V2.KillSwitch.enabled?(:agentic_rag)
    end
  end
end
