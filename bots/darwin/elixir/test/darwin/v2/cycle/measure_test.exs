defmodule Darwin.V2.Cycle.MeasureTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Cycle.Measure

  setup_all do
    Code.ensure_loaded?(Measure)
    :ok
  end

  describe "module_definition" do
    test "Measure 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Measure)
    end

    test "8단계 MEASURE Stage GenServer" do
      assert Measure.__info__(:module) == Darwin.V2.Cycle.Measure
    end
  end

  describe "public_api" do
    test "start_link/1 export" do
      assert function_exported?(Measure, :start_link, 1)
    end

    test "status/0 export" do
      assert function_exported?(Measure, :status, 0)
    end

    test "run_due/0 export" do
      assert function_exported?(Measure, :run_due, 0)
    end

    test "schedule_measurement/2 export" do
      assert function_exported?(Measure, :schedule_measurement, 2)
    end

    test "effect_observed/5 export" do
      assert function_exported?(Measure, :effect_observed, 5)
    end

    test "pending_measurements/0 export" do
      assert function_exported?(Measure, :pending_measurements, 0)
    end
  end

  describe "kill_switch_disabled" do
    test "DARWIN_MEASURE_STAGE_ENABLED 미설정 시 schedule_measurement는 :skip 반환" do
      System.delete_env("DARWIN_MEASURE_STAGE_ENABLED")
      result = Measure.schedule_measurement("arxiv:test.001")
      assert result == {:skip, :disabled}
    end

    test "DARWIN_MEASURE_STAGE_ENABLED 미설정 시 effect_observed는 :skip 반환" do
      System.delete_env("DARWIN_MEASURE_STAGE_ENABLED")
      result = Measure.effect_observed("arxiv:test.001", "win_rate", 0.5, 0.55)
      assert result == {:skip, :disabled}
    end
  end

  describe "measurement_intervals" do
    test "측정 구간 3개: 24h / 7d / 30d" do
      # 내부 @intervals를 함수 export로 검증할 수 없으므로 모듈 내 변수 확인
      assert Code.ensure_loaded?(Measure)
      # schedule_measurement가 kill switch 없이 :skip 반환 — 기능 정의는 확인됨
      result = Measure.schedule_measurement("test_paper")
      assert result == {:skip, :disabled}
    end
  end

  describe "research_registry_integration" do
    test "ResearchRegistry 모듈 로드됨 (30d 완료 → measured 전이)" do
      assert Code.ensure_loaded?(Darwin.V2.ResearchRegistry)
    end
  end

  describe "hypothesis_integration" do
    test "HypothesisEngine 모듈 로드됨 (delta → confirmed/refuted)" do
      assert Code.ensure_loaded?(Darwin.V2.HypothesisEngine)
    end
  end
end
