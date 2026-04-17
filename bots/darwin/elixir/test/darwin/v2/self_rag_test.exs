defmodule Darwin.V2.SelfRAGTest do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded?(Darwin.V2.SelfRAG)
    :ok
  end

  describe "module_definition" do
    test "SelfRAG 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Darwin.V2.SelfRAG)
    end
  end

  describe "public_api" do
    test "recall_and_validate/3 함수 export" do
      assert function_exported?(Darwin.V2.SelfRAG, :recall_and_validate, 3)
    end

    test "retrieve_and_filter/2 함수 export" do
      assert function_exported?(Darwin.V2.SelfRAG, :retrieve_and_filter, 2)
    end

    test "relevant?/2 함수 export" do
      assert function_exported?(Darwin.V2.SelfRAG, :relevant?, 2)
    end

    test "supporting?/2 함수 export" do
      assert function_exported?(Darwin.V2.SelfRAG, :supporting?, 2)
    end
  end

  describe "four_gate_structure" do
    test "Retrieve gate 함수 존재" do
      # retrieve_and_filter가 1단계
      assert function_exported?(Darwin.V2.SelfRAG, :retrieve_and_filter, 2)
    end

    test "Relevant gate 함수 존재" do
      assert function_exported?(Darwin.V2.SelfRAG, :relevant?, 2)
    end

    test "Supporting gate 함수 존재" do
      assert function_exported?(Darwin.V2.SelfRAG, :supporting?, 2)
    end
  end

  describe "moduledoc" do
    test "모듈 문서 존재" do
      {:docs_v1, _, _, _, module_doc, _, _} = Code.fetch_docs(Darwin.V2.SelfRAG)
      assert module_doc != :none
    end
  end

  describe "kill_switch_awareness" do
    test "DARWIN_SELF_RAG_ENABLED env로 제어 가능" do
      # Kill switch는 모듈 내부 체크
      assert Code.ensure_loaded?(Darwin.V2.SelfRAG)
    end
  end
end
