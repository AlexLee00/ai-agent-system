defmodule Darwin.V2.LLM.SelectorTest do
  use ExUnit.Case

  test "policy_for/1 알려진 에이전트 정책 반환" do
    policy = Darwin.V2.LLM.Selector.policy_for("evaluate")
    assert policy.route == :local_fast
    assert is_list(policy.fallback)
  end

  test "policy_for/1 미지 에이전트 기본 정책 반환" do
    policy = Darwin.V2.LLM.Selector.policy_for("unknown_agent_xyz")
    assert policy.route == :local_fast
  end

  test "implement 에이전트는 anthropic_sonnet 사용" do
    policy = Darwin.V2.LLM.Selector.policy_for("implement")
    assert policy.route == :anthropic_sonnet
  end

  test "plan 에이전트는 local_deep 사용" do
    policy = Darwin.V2.LLM.Selector.policy_for("plan")
    assert policy.route == :local_deep
  end
end
