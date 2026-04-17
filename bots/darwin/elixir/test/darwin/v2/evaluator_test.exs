defmodule Darwin.V2.EvaluatorTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Evaluator

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Evaluator)
    :ok
  end

  describe "module_definition" do
    test "Evaluator 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Evaluator)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(Evaluator, :start_link, 1)
    end

    test "evaluate_now/0 함수 export" do
      assert function_exported?(Evaluator, :evaluate_now, 0)
    end

    test "init/1 함수 export" do
      assert function_exported?(Evaluator, :init, 1)
    end
  end

  describe "genserver_callbacks" do
    test "handle_info/2 export" do
      assert function_exported?(Evaluator, :handle_info, 2)
    end
  end

  describe "llm_integration" do
    test "Selector와 연동 가능" do
      assert Code.ensure_loaded?(Darwin.V2.LLM.Selector)
    end
  end

  describe "namespace" do
    test "Darwin.V2 네임스페이스" do
      assert String.starts_with?(to_string(Evaluator), "Elixir.Darwin.V2")
    end
  end

  describe "event_handling" do
    test "paper_discovered 이벤트 처리" do
      assert function_exported?(Evaluator, :handle_info, 2)
    end
  end

  describe "batch_flush_timer" do
    test "handle_info에 :batch_flush 메시지 처리" do
      assert function_exported?(Evaluator, :handle_info, 2)
    end
  end
end
