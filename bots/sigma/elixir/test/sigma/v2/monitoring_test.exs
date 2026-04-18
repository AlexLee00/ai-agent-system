defmodule Sigma.V2.MonitoringTest do
  use ExUnit.Case, async: true

  @moduletag :phase_m

  describe "Sigma.V2.Monitoring — 반환 구조" do
    test "daily_summary/0 는 맵 반환" do
      result = Sigma.V2.Monitoring.daily_summary()
      assert is_map(result)
    end

    test "daily_summary/0 에 date 키 포함" do
      result = Sigma.V2.Monitoring.daily_summary()
      assert Map.has_key?(result, :date)
    end

    test "daily_summary/0 에 cycles 키 포함" do
      result = Sigma.V2.Monitoring.daily_summary()
      assert Map.has_key?(result, :cycles)
    end

    test "daily_summary/0 에 directives 키 포함" do
      result = Sigma.V2.Monitoring.daily_summary()
      assert Map.has_key?(result, :directives)
    end

    test "weekly_summary/0 는 맵 반환" do
      result = Sigma.V2.Monitoring.weekly_summary()
      assert is_map(result)
    end

    test "weekly_summary/0 에 cycles 키 포함" do
      result = Sigma.V2.Monitoring.weekly_summary()
      assert Map.has_key?(result, :cycles)
    end

    test "weekly_summary/0 에 dpo 키 포함" do
      result = Sigma.V2.Monitoring.weekly_summary()
      assert Map.has_key?(result, :dpo)
    end

    test "daily_summary/0 DB 없이도 실패하지 않음" do
      result = Sigma.V2.Monitoring.daily_summary()
      assert is_map(result)
    end
  end

  describe "Sigma.V2.Pod.Performance — 직접 호출" do
    test "record_directive/4 DB 없어도 :ok 반환" do
      result = Sigma.V2.Pod.Performance.record_directive("trend", "luna", "dir-test-001", true)
      assert result == :ok
    end

    test "evaluate_weekly/0 DB 없어도 :ok 반환" do
      result = Sigma.V2.Pod.Performance.evaluate_weekly()
      assert result == :ok
    end

    test "accuracy_by_pod/1 DB 없어도 맵 반환" do
      result = Sigma.V2.Pod.Performance.accuracy_by_pod(7)
      assert is_map(result)
    end

    test "accuracy_by_pod/1 에 유효한 값 반환" do
      result = Sigma.V2.Pod.Performance.accuracy_by_pod(30)
      assert is_map(result)
      Enum.each(result, fn {pod, stats} ->
        assert is_binary(pod)
        assert is_map(stats)
      end)
    end
  end
end
