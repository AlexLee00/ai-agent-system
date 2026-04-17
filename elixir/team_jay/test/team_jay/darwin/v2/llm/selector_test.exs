defmodule Darwin.V2.LLM.SelectorTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.LLM.Selector

  describe "policy_for/1 — 정적 정책" do
    test "evaluator → anthropic_sonnet" do
      policy = Selector.policy_for("evaluator")
      assert policy.route == :anthropic_sonnet
    end

    test "scanner → anthropic_haiku (경량 작업)" do
      policy = Selector.policy_for("scanner")
      assert policy.route == :anthropic_haiku
    end

    test "principle.critique → anthropic_opus (최고 품질)" do
      policy = Selector.policy_for("principle.critique")
      assert policy.route == :anthropic_opus
    end

    test "알 수 없는 에이전트 → anthropic_haiku 기본값" do
      policy = Selector.policy_for("nonexistent_agent")
      assert policy.route == :anthropic_haiku
    end

    test "atom도 string으로 변환하여 처리" do
      assert Selector.policy_for(:evaluator) == Selector.policy_for("evaluator")
    end

    test "V2 네임스페이스 에이전트 매핑" do
      policy = Selector.policy_for("darwin.commander")
      assert policy.route in [:anthropic_opus, :anthropic_sonnet]
    end
  end

  describe "call_with_fallback/3 — Kill Switch OFF" do
    test "DARWIN_V2_ENABLED=false이면 {:error, :selector_disabled}" do
      System.delete_env("DARWIN_V2_ENABLED")
      System.delete_env("DARWIN_LLM_SELECTOR_ENABLED")

      result = Selector.call_with_fallback("evaluator", "테스트 프롬프트")
      assert result == {:error, :selector_disabled}
    end
  end
end
