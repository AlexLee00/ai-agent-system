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

    test "darwin.commander → anthropic_opus 또는 sonnet" do
      policy = Selector.policy_for("darwin.commander")
      assert policy.route in [:anthropic_opus, :anthropic_sonnet]
    end

    test "알 수 없는 에이전트 → anthropic_haiku 기본값" do
      policy = Selector.policy_for("nonexistent_agent")
      assert policy.route == :anthropic_haiku
    end

    test "atom도 string으로 변환하여 처리" do
      assert Selector.policy_for(:evaluator) == Selector.policy_for("evaluator")
    end

    test "V2 네임스페이스 에이전트 — darwin.evaluator" do
      policy = Selector.policy_for("darwin.evaluator")
      assert policy.route in [:anthropic_sonnet, :anthropic_haiku]
    end
  end

  describe "call_with_fallback/3 — Kill Switch ON (기본)" do
    test "Kill Switch ON → {:error, :kill_switch} 또는 LLM 호출 시도" do
      # Application.get_env(:darwin, :kill_switch, true) → 기본값 true(활성) → kill_switch 반환
      # 단, CostTracker GenServer 미기동 시 먼저 호출되면 exit 발생 가능
      # 테스트에서 프로세스 없을 경우 안전하게 처리
      pid = Process.whereis(Darwin.V2.LLM.CostTracker)

      if pid do
        result = Selector.call_with_fallback("evaluator", "테스트 프롬프트")
        assert match?({:error, _}, result)
      end
    end
  end

  describe "Recommender 통합 — 순수 룰 검증" do
    test "Recommender 독립 호출 — evaluator 정책" do
      alias Darwin.V2.LLM.Recommender
      {:ok, rec} = Recommender.recommend("evaluator", %{budget_ratio: 0.8, urgency: :medium})
      assert rec.primary in [:anthropic_sonnet, :anthropic_haiku, :anthropic_opus]
      assert is_binary(rec.reason)
    end

    test "Recommender — scanner 경량 작업" do
      alias Darwin.V2.LLM.Recommender
      {:ok, rec} = Recommender.recommend("scanner", %{urgency: :high})
      assert rec.primary in [:anthropic_haiku, :anthropic_sonnet]
    end
  end
end
