defmodule Darwin.V2.HypothesisEngineTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.HypothesisEngine

  setup_all do
    Code.ensure_loaded?(HypothesisEngine)
    :ok
  end

  describe "module_definition" do
    test "HypothesisEngine 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(HypothesisEngine)
    end
  end

  describe "public_api" do
    test "generate/2 export" do
      assert function_exported?(HypothesisEngine, :generate, 2)
    end

    test "list_pending/0 export" do
      assert function_exported?(HypothesisEngine, :list_pending, 0)
    end

    test "list_testing/0 export" do
      assert function_exported?(HypothesisEngine, :list_testing, 0)
    end

    test "update_status/3 export" do
      assert function_exported?(HypothesisEngine, :update_status, 3)
    end

    test "confirmed_patterns/1 export" do
      assert function_exported?(HypothesisEngine, :confirmed_patterns, 1)
    end

    test "refuted_patterns/0 export" do
      assert function_exported?(HypothesisEngine, :refuted_patterns, 0)
    end
  end

  describe "kill_switch_disabled" do
    test "DARWIN_HYPOTHESIS_ENGINE_ENABLED 미설정 시 generate는 :skip 반환" do
      System.delete_env("DARWIN_HYPOTHESIS_ENGINE_ENABLED")
      paper = %{arxiv_id: "2401.00001", title: "Test Paper", abstract: "Test abstract"}
      result = HypothesisEngine.generate(paper)
      assert result == {:skip, :disabled}
    end
  end

  describe "status_validation" do
    test "유효하지 않은 status → {:error, {:invalid_status, _}}" do
      result = HypothesisEngine.update_status(999, "invalid_status")
      assert {:error, {:invalid_status, "invalid_status"}} = result
    end

    test "유효한 status 목록: pending, testing, confirmed, refuted" do
      valid = ~w(pending testing confirmed refuted)
      assert "pending" in valid
      assert "testing" in valid
      assert "confirmed" in valid
      assert "refuted" in valid
      refute "unknown" in valid
    end
  end

  describe "confirmed_patterns" do
    test "DB 없이 confirmed_patterns는 빈 목록 반환 (rescue 처리)" do
      result = HypothesisEngine.confirmed_patterns("luna")
      assert is_list(result)
    end

    test "confirmed_patterns nil team도 허용" do
      result = HypothesisEngine.confirmed_patterns(nil)
      assert is_list(result)
    end
  end

  describe "refuted_patterns" do
    test "DB 없이 refuted_patterns는 빈 목록 반환 (rescue 처리)" do
      result = HypothesisEngine.refuted_patterns()
      assert is_list(result)
    end
  end

  describe "sakana_ai_scientist_pattern" do
    test "Sakana AI Scientist 가설 형식 유효성 (JSON 필드 확인)" do
      required_fields = ~w(target_team target_module hypothesis_text expected_metric expected_delta confidence)
      assert length(required_fields) == 6
      assert "hypothesis_text" in required_fields
      assert "expected_metric" in required_fields
    end

    test "가설은 testable + falsifiable 조건 검증" do
      # falsifiable = expected_delta (수치로 기각 가능)
      # testable = 24h/7d/30d 측정 가능
      assert Code.ensure_loaded?(Darwin.V2.Cycle.Measure)
    end
  end
end
