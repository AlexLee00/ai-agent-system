defmodule Luna.V2.Validation.EngineTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Validation.{Engine, Backtest, WalkForward, ShadowValidation, ValidationLive, PromotionGate}

  setup_all do
    Code.ensure_compiled!(Engine)
    Code.ensure_compiled!(Backtest)
    Code.ensure_compiled!(WalkForward)
    Code.ensure_compiled!(ShadowValidation)
    Code.ensure_compiled!(ValidationLive)
    Code.ensure_compiled!(PromotionGate)
    :ok
  end

  # Engine은 GenServer + DB 의존 → 컴파일 확인 + 모듈 존재 확인만
  describe "모듈 구조 확인" do
    test "Engine 모듈 컴파일됨" do
      assert Code.ensure_loaded?(Engine)
    end

    test "Backtest 모듈 컴파일됨" do
      assert Code.ensure_loaded?(Backtest)
    end

    test "WalkForward 모듈 컴파일됨" do
      assert Code.ensure_loaded?(WalkForward)
    end

    test "ShadowValidation 모듈 컴파일됨" do
      assert Code.ensure_loaded?(ShadowValidation)
    end

    test "ValidationLive 모듈 컴파일됨" do
      assert Code.ensure_loaded?(ValidationLive)
    end

    test "PromotionGate 모듈 컴파일됨" do
      assert Code.ensure_loaded?(PromotionGate)
    end

    test "Engine에 validate_strategy/1 함수 존재 (기본값 포함)" do
      assert function_exported?(Engine, :validate_strategy, 1)
    end

    test "Engine에 run_all_pending/0 함수 존재" do
      assert function_exported?(Engine, :run_all_pending, 0)
    end
  end
end
