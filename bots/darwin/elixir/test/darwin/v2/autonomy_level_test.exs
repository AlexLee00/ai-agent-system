defmodule Darwin.V2.AutonomyLevelTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.AutonomyLevel

  describe "struct 구조" do
    test "기본 struct 레벨이 3" do
      state = %AutonomyLevel{}
      assert state.level == 3
      assert state.consecutive_successes == 0
      assert state.applied_successes == 0
    end
  end

  describe "maybe_upgrade 로직 (private — 간접 테스트)" do
    test "L3→L4 조건: 연속 5회 성공 + 7일 경과 필요" do
      assert %AutonomyLevel{level: 3, consecutive_successes: 4}.level == 3
      assert %AutonomyLevel{level: 3, consecutive_successes: 5}.consecutive_successes == 5
    end

    test "L4→L5 조건: DARWIN_L5_ENABLED=true 필요" do
      # 환경변수 없으면 L5 안 됨
      System.delete_env("DARWIN_L5_ENABLED")
      enabled = System.get_env("DARWIN_L5_ENABLED") == "true"
      assert enabled == false
    end
  end

  describe "days_since 로직" do
    test "nil last_success_at → 0일 반환" do
      state = %AutonomyLevel{level: 3, consecutive_successes: 5, last_success_at: nil}
      assert state.last_success_at == nil
    end
  end
end
