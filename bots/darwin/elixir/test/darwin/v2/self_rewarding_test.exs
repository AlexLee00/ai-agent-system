defmodule Darwin.V2.SelfRewardingTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.SelfRewarding

  # 각 테스트 종료 후 환경변수 초기화
  setup do
    on_exit(fn ->
      System.delete_env("DARWIN_SELF_REWARDING_ENABLED")
    end)
  end

  describe "evaluate_cycle/1 — kill switch OFF" do
    test "DARWIN_SELF_REWARDING_ENABLED 없으면 즉시 :ok 반환" do
      System.delete_env("DARWIN_SELF_REWARDING_ENABLED")
      assert :ok == SelfRewarding.evaluate_cycle("cycle-001")
    end

    test "DARWIN_SELF_REWARDING_ENABLED=false 이면 :ok 반환" do
      System.put_env("DARWIN_SELF_REWARDING_ENABLED", "false")
      assert :ok == SelfRewarding.evaluate_cycle(%{cycle_id: "test"})
    end
  end

  describe "evaluate_cycle/1 — 입력 형식" do
    test "맵 입력도 :ok 반환 (kill switch OFF)" do
      cycle_result = %{
        cycle_id: "test-cycle-map",
        paper_title: "Test Paper",
        stage: "evaluate",
        evaluation_score: 8.0
      }

      System.delete_env("DARWIN_SELF_REWARDING_ENABLED")
      assert :ok == SelfRewarding.evaluate_cycle(cycle_result)
    end

    test "문자열 cycle_id도 :ok 반환 (kill switch OFF)" do
      System.delete_env("DARWIN_SELF_REWARDING_ENABLED")
      assert :ok == SelfRewarding.evaluate_cycle("cycle-string-id")
    end

    test "정수 cycle_id도 :ok 반환 (kill switch OFF)" do
      System.delete_env("DARWIN_SELF_REWARDING_ENABLED")
      assert :ok == SelfRewarding.evaluate_cycle(42)
    end
  end

  describe "evaluate_week/0 — kill switch OFF" do
    test "DARWIN_SELF_REWARDING_ENABLED=false 이면 즉시 :ok 반환" do
      System.put_env("DARWIN_SELF_REWARDING_ENABLED", "false")
      assert :ok == SelfRewarding.evaluate_week()
    end
  end

  describe "rebalance_recommender_monthly/0 — kill switch OFF" do
    test "kill switch OFF 이면 즉시 :ok 반환" do
      System.delete_env("DARWIN_SELF_REWARDING_ENABLED")
      assert :ok == SelfRewarding.rebalance_recommender_monthly()
    end
  end

  describe "parse_judgment — 내부 로직 (모듈 함수 직접 접근 불가, 통합 경로 검증)" do
    @tag :integration
    test "evaluate_cycle — kill switch ON이면 DB/LLM 없이도 오류 없이 완료" do
      # kill switch ON이지만 LLM/DB 없음 → 내부 오류를 조용히 처리 후 :ok
      System.put_env("DARWIN_SELF_REWARDING_ENABLED", "true")

      result = SelfRewarding.evaluate_cycle(%{
        cycle_id: "integration-test-#{System.unique_integer()}",
        paper_title: "Test Paper",
        stage: "evaluate",
        evaluation_score: 7.0,
        implementation_success: true,
        verification_success: false,
        applied: false,
        principle_violations: 0,
        duration_sec: 120,
        llm_cost_usd: 0.05
      })

      # LLM/DB 없으면 :ok 또는 {:ok, judgment} 중 하나
      assert result == :ok or match?({:ok, %{score: _}}, result)
    end

    @tag :integration
    test "evaluate_week — kill switch ON이면 DB 없어도 오류 없이 :ok" do
      System.put_env("DARWIN_SELF_REWARDING_ENABLED", "true")
      assert :ok == SelfRewarding.evaluate_week()
    end

    @tag :integration
    test "rebalance_recommender_monthly — kill switch ON이면 DB 없어도 오류 없이 :ok" do
      System.put_env("DARWIN_SELF_REWARDING_ENABLED", "true")
      assert :ok == SelfRewarding.rebalance_recommender_monthly()
    end
  end

  describe "KillSwitch :self_rewarding 연동" do
    test "enabled?(:self_rewarding) 기본값은 false" do
      System.delete_env("DARWIN_SELF_REWARDING_ENABLED")
      refute Darwin.V2.KillSwitch.enabled?(:self_rewarding)
    end

    test "DARWIN_SELF_REWARDING_ENABLED=true 이면 enabled?/1 true" do
      System.put_env("DARWIN_SELF_REWARDING_ENABLED", "true")
      assert Darwin.V2.KillSwitch.enabled?(:self_rewarding)
    end
  end
end
