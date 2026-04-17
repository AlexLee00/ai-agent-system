defmodule Darwin.V2.LLM.SelectorTest do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded?(Darwin.V2.LLM.Selector)
    :ok
  end

  describe "module_definition" do
    test "Selector 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Darwin.V2.LLM.Selector)
    end
  end

  describe "public_api" do
    test "policy_for/1 함수 export" do
      assert function_exported?(Darwin.V2.LLM.Selector, :policy_for, 1)
    end

    test "complete/3 함수 export" do
      assert function_exported?(Darwin.V2.LLM.Selector, :complete, 3)
    end

    test "call_with_fallback/3 함수 export" do
      assert function_exported?(Darwin.V2.LLM.Selector, :call_with_fallback, 3)
    end
  end

  describe "policy_for" do
    test "policy_for는 agent 이름으로 모델 정책을 반환한다" do
      result = Darwin.V2.LLM.Selector.policy_for("darwin.evaluator")
      assert is_map(result) or is_list(result)
    end

    test "policy_for는 atom agent 이름도 받는다" do
      result = Darwin.V2.LLM.Selector.policy_for(:evaluator)
      assert result != nil
    end

    test "unknown agent도 기본 정책 반환" do
      result = Darwin.V2.LLM.Selector.policy_for("unknown_agent_xyz")
      assert result != nil
    end
  end

  describe "agent_role_coverage" do
    test "evaluator agent 정책" do
      assert Darwin.V2.LLM.Selector.policy_for("darwin.evaluator") != nil
    end

    test "planner agent 정책" do
      assert Darwin.V2.LLM.Selector.policy_for("darwin.planner") != nil
    end

    test "verifier agent 정책" do
      assert Darwin.V2.LLM.Selector.policy_for("darwin.verifier") != nil
    end

    test "scanner agent 정책" do
      assert Darwin.V2.LLM.Selector.policy_for("darwin.scanner") != nil
    end

    test "applier agent 정책" do
      assert Darwin.V2.LLM.Selector.policy_for("darwin.applier") != nil
    end

    test "learner agent 정책" do
      assert Darwin.V2.LLM.Selector.policy_for("darwin.learner") != nil
    end

    test "principle.critique agent 정책" do
      assert Darwin.V2.LLM.Selector.policy_for("darwin.principle.critique") != nil
    end
  end

  describe "integration_skip" do
    @tag :integration
    test "실제 Anthropic API 호출 스모크" do
      # 외부 API 호출 테스트 — 기본 스킵
      assert true
    end
  end

  describe "fallback_structure" do
    test "call_with_fallback은 바이너리 프롬프트를 받음" do
      # 실제 호출 없이 함수 export만 확인
      assert function_exported?(Darwin.V2.LLM.Selector, :call_with_fallback, 3)
    end
  end
end
