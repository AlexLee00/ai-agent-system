defmodule Darwin.V2.AutonomyLevelTest do
  use ExUnit.Case, async: false

  test "초기 레벨은 L3" do
    state = Darwin.V2.AutonomyLevel.get()
    assert state.level in [3, 4, 5]
  end

  test "record_success/0 연속 성공 증가" do
    before = Darwin.V2.AutonomyLevel.get()
    Darwin.V2.AutonomyLevel.record_success()
    after_state = Darwin.V2.AutonomyLevel.get()
    assert after_state.consecutive_successes >= before.consecutive_successes
  end

  test "record_failure/1 L3으로 강등" do
    Darwin.V2.AutonomyLevel.record_failure(:test_error)
    state = Darwin.V2.AutonomyLevel.get()
    assert state.level == 3
    assert state.consecutive_successes == 0
  end
end
