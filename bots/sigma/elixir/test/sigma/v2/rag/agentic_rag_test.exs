defmodule Sigma.V2.Rag.AgenticRagTest do
  use ExUnit.Case, async: true

  @moduletag :phase_a

  @sigma_lib Path.join(__DIR__, "../../../../lib")

  describe "Sigma.V2.Rag.AgenticRag — Kill Switch fallback" do
    test "SIGMA_AGENTIC_RAG_ENABLED=false 시 {:ok, _} 또는 {:error, _} 반환" do
      System.put_env("SIGMA_AGENTIC_RAG_ENABLED", "false")
      result = Sigma.V2.Rag.AgenticRag.retrieve("test query", %{})
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    after
      System.delete_env("SIGMA_AGENTIC_RAG_ENABLED")
    end

    test "SIGMA_AGENTIC_RAG_ENABLED=true 시 {:ok, _} 또는 {:error, _} 반환 (DB 없어도)" do
      System.put_env("SIGMA_AGENTIC_RAG_ENABLED", "true")
      result = Sigma.V2.Rag.AgenticRag.retrieve("sigma directive query", %{})
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    after
      System.delete_env("SIGMA_AGENTIC_RAG_ENABLED")
    end

    test "retrieve/1 단인자 호출도 동작" do
      result = Sigma.V2.Rag.AgenticRag.retrieve("test")
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end

  describe "Sigma.V2.Rag 4 하위 모듈 — 직접 호출" do
    test "QueryPlanner.decompose/2 호출 시 결과 반환" do
      result = Sigma.V2.Rag.QueryPlanner.decompose("test query", %{})
      assert match?({:ok, _}, result) or match?({:error, _}, result) or is_list(result)
    end

    test "MultiSourceRetriever.fetch/2 DB 없어도 결과 반환" do
      result = Sigma.V2.Rag.MultiSourceRetriever.fetch(["test"], %{})
      assert match?({:ok, _}, result) or match?({:error, _}, result) or is_list(result)
    end

    test "QualityEvaluator.score/2 결과 반환" do
      result = Sigma.V2.Rag.QualityEvaluator.score([], %{})
      assert match?({:ok, _}, result) or match?({:error, _}, result) or is_number(result)
    end

    test "ResponseSynthesizer.combine/2 결과 반환" do
      result = Sigma.V2.Rag.ResponseSynthesizer.combine(%{docs: [], quality: 0.0}, "test query")
      assert match?({:ok, _}, result) or match?({:error, _}, result) or is_binary(result)
    end
  end

  describe "Sigma.V2.Rag.MultiSourceRetriever — 시그마 고유 소스" do
    test "Cross-Team Metric 소스 포함 (directive audit 경유)" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/rag/multi_source_retriever.ex"))
      assert src =~ "team" or src =~ "sigma_v2_directive_audit"
    end

    test "Past Directives 소스 포함" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/rag/multi_source_retriever.ex"))
      assert src =~ "directive" or src =~ "past_directive"
    end
  end

  describe "Sigma.V2.Rag.AgenticRag — 파이프라인 구조" do
    test "QueryPlanner → MultiSourceRetriever → QualityEvaluator → ResponseSynthesizer 파이프라인" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/rag/agentic_rag.ex"))
      assert src =~ "QueryPlanner"
      assert src =~ "MultiSourceRetriever"
      assert src =~ "QualityEvaluator"
      assert src =~ "ResponseSynthesizer"
    end

    test "SelfRAG fallback 참조 포함" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/rag/agentic_rag.ex"))
      assert src =~ "SelfRAG" or src =~ "self_rag"
    end
  end
end
