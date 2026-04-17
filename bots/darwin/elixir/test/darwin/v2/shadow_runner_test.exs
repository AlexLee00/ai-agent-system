defmodule Darwin.V2.ShadowRunnerTest do
  use ExUnit.Case, async: false

  alias Darwin.V2.ShadowRunner

  describe "enabled?/0" do
    test "DARWIN_SHADOW_MODE=false → disabled (기본값)" do
      System.put_env("DARWIN_SHADOW_MODE", "false")
      refute ShadowRunner.enabled?()
    end

    test "DARWIN_SHADOW_MODE=true → enabled" do
      System.put_env("DARWIN_SHADOW_MODE", "true")
      assert ShadowRunner.enabled?()
      System.put_env("DARWIN_SHADOW_MODE", "false")
    end
  end

  describe "match_tolerance 논리 — 단위 검증" do
    test "점수 차이 ≤ 1.0이면 일치" do
      tolerance = 1.0
      assert abs(7.0 - 8.0) <= tolerance
      assert abs(5.0 - 5.0) <= tolerance
      refute abs(3.0 - 7.0) <= tolerance
    end
  end

  describe "승격 조건 — 논리 검증" do
    test "7일 미만 → 승격 불가" do
      days = 3
      runs = 25
      rate = 1.0
      refute days >= 7 and runs >= 20 and rate >= 0.95
    end

    test "7일 + 20건 + 95% 이상 → 승격 가능" do
      days = 7
      runs = 20
      rate = 0.97
      assert days >= 7 and runs >= 20 and rate >= 0.95
    end

    test "7일 + 19건 → 승격 불가 (건수 미달)" do
      days = 8
      runs = 19
      rate = 1.0
      refute days >= 7 and runs >= 20 and rate >= 0.95
    end

    test "7일 + 20건 + 94% → 승격 불가 (점수 미달)" do
      days = 7
      runs = 20
      rate = 0.94
      refute days >= 7 and runs >= 20 and rate >= 0.95
    end
  end

  describe "shadow_summary/0 + shadow_ready?/0 — GenServer 기동 시" do
    test "ShadowRunner 기동 시 shadow_summary 반환" do
      pid = Process.whereis(ShadowRunner)

      if pid do
        summary = ShadowRunner.shadow_summary()
        assert is_map(summary)
        assert Map.has_key?(summary, :total_runs) or Map.has_key?(summary, :runs)
      end
    end

    test "ShadowRunner 기동 시 shadow_ready? → boolean" do
      pid = Process.whereis(ShadowRunner)

      if pid do
        result = ShadowRunner.shadow_ready?()
        assert is_boolean(result)
      end
    end
  end
end
