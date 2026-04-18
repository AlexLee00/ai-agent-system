defmodule Luna.V2.Validation.EngineTest do
  use ExUnit.Case, async: true

  # Engine은 GenServer + DB 의존 → 컴파일 확인 + 모듈 존재 확인만
  describe "모듈 구조 확인" do
    test "Engine 모듈 컴파일됨" do
      assert Code.ensure_loaded?(Luna.V2.Validation.Engine)
    end

    test "Backtest 모듈 컴파일됨" do
      assert Code.ensure_loaded?(Luna.V2.Validation.Backtest)
    end

    test "WalkForward 모듈 컴파일됨" do
      assert Code.ensure_loaded?(Luna.V2.Validation.WalkForward)
    end

    test "ShadowValidation 모듈 컴파일됨" do
      assert Code.ensure_loaded?(Luna.V2.Validation.ShadowValidation)
    end

    test "ValidationLive 모듈 컴파일됨" do
      assert Code.ensure_loaded?(Luna.V2.Validation.ValidationLive)
    end

    test "PromotionGate 모듈 컴파일됨" do
      assert Code.ensure_loaded?(Luna.V2.Validation.PromotionGate)
    end

    test "Engine에 validate_strategy/1 함수 존재 (기본값 포함)" do
      assert function_exported?(Luna.V2.Validation.Engine, :validate_strategy, 1)
    end

    test "Engine에 run_all_pending/0 함수 존재" do
      assert function_exported?(Luna.V2.Validation.Engine, :run_all_pending, 0)
    end
  end
end
