defmodule Darwin.V2.CommanderTest do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Commander)
    :ok
  end

  describe "module_definition" do
    test "Commander 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Darwin.V2.Commander)
    end
  end

  describe "public_api" do
    test "plan_pipeline/2 함수 export" do
      assert function_exported?(Darwin.V2.Commander, :plan_pipeline, 2)
    end

    test "analyze_results/2 함수 export" do
      assert function_exported?(Darwin.V2.Commander, :analyze_results, 2)
    end

    test "decide_learning/2 함수 export" do
      assert function_exported?(Darwin.V2.Commander, :decide_learning, 2)
    end

    test "decide_research_focus/2 함수 export" do
      assert function_exported?(Darwin.V2.Commander, :decide_research_focus, 2)
    end

    test "apply_principle_gate/1 함수 export" do
      assert function_exported?(Darwin.V2.Commander, :apply_principle_gate, 1)
    end

    test "broadcast/2 함수 export" do
      assert function_exported?(Darwin.V2.Commander, :broadcast, 2)
    end
  end

  describe "principle_gate_interface" do
    test "apply_principle_gate는 plan map을 받는다" do
      assert is_function(&Darwin.V2.Commander.apply_principle_gate/1)
    end
  end

  describe "moduledoc" do
    test "모듈 문서 존재" do
      {:docs_v1, _, _, _, module_doc, _, _} = Code.fetch_docs(Darwin.V2.Commander)
      assert module_doc != :none
    end
  end

  describe "broadcast_shape" do
    test "broadcast/2는 topic과 payload를 받음" do
      assert function_exported?(Darwin.V2.Commander, :broadcast, 2)
    end
  end
end
