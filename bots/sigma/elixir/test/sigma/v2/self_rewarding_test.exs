defmodule Sigma.V2.SelfRewardingTest do
  use ExUnit.Case, async: true

  @moduletag :phase_s

  @sigma_lib Path.join(__DIR__, "../../../lib")

  describe "Sigma.V2.SelfRewarding — Kill Switch" do
    test "SIGMA_SELF_REWARDING_ENABLED 미설정 시 :ok 반환 (무해 실패)" do
      System.delete_env("SIGMA_SELF_REWARDING_ENABLED")
      result = Sigma.V2.SelfRewarding.evaluate_cycle(%{cycle_id: "test"})
      assert result == :ok
    end

    test "SIGMA_SELF_REWARDING_ENABLED=false 시 evaluate_week :ok" do
      System.put_env("SIGMA_SELF_REWARDING_ENABLED", "false")
      result = Sigma.V2.SelfRewarding.evaluate_week()
      assert result == :ok
    after
      System.delete_env("SIGMA_SELF_REWARDING_ENABLED")
    end

    test "SIGMA_SELF_REWARDING_ENABLED=false 시 rebalance :ok" do
      System.put_env("SIGMA_SELF_REWARDING_ENABLED", "false")
      result = Sigma.V2.SelfRewarding.rebalance_analyst_monthly()
      assert result == :ok
    after
      System.delete_env("SIGMA_SELF_REWARDING_ENABLED")
    end
  end

  describe "Sigma.V2.SelfRewarding — 사이클 평가 (DB 없이)" do
    test "빈 사이클 맵 전달 시 :ok 또는 {:ok, _} 반환" do
      System.put_env("SIGMA_SELF_REWARDING_ENABLED", "true")
      result = Sigma.V2.SelfRewarding.evaluate_cycle(%{})
      assert result == :ok or match?({:ok, _}, result)
    after
      System.delete_env("SIGMA_SELF_REWARDING_ENABLED")
    end

    test "results 포함 사이클 맵 전달 시 :ok 또는 {:ok, _} 반환" do
      System.put_env("SIGMA_SELF_REWARDING_ENABLED", "true")

      cycle = %{
        cycle_id: "unit-test-#{:rand.uniform(9999)}",
        date: Date.to_iso8601(Date.utc_today()),
        analyst: "trend",
        team: "blog",
        results: [
          %{status: :ok, feedback: %{target_team: "blog", tier: 1}},
          %{status: :error, feedback: %{target_team: "blog", tier: 1}}
        ]
      }

      result = Sigma.V2.SelfRewarding.evaluate_cycle(cycle)
      assert result == :ok or match?({:ok, _}, result)
    after
      System.delete_env("SIGMA_SELF_REWARDING_ENABLED")
    end

    test "evaluate_week/0 는 DB 없어도 :ok 반환" do
      System.put_env("SIGMA_SELF_REWARDING_ENABLED", "true")
      result = Sigma.V2.SelfRewarding.evaluate_week()
      assert result == :ok
    after
      System.delete_env("SIGMA_SELF_REWARDING_ENABLED")
    end
  end

  describe "Sigma.V2.SelfRewarding — 소스 구조 검증" do
    test "선호 임계값 상수 정의됨" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/self_rewarding.ex"))
      assert src =~ "@preferred_threshold"
      assert src =~ "@rejected_threshold"
    end

    test "LLM-as-a-Judge 프롬프트 포함" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/self_rewarding.ex"))
      assert src =~ "llm_judge"
    end

    test "sigma_dpo_preference_pairs INSERT 쿼리 포함" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/self_rewarding.ex"))
      assert src =~ "sigma_dpo_preference_pairs"
    end
  end
end
