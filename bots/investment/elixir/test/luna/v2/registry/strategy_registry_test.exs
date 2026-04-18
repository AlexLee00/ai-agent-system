defmodule Luna.V2.Registry.StrategyRegistryTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Registry.StrategyRegistry

  setup_all do
    Code.ensure_compiled!(StrategyRegistry)
    :ok
  end

  describe "모듈 구조" do
    test "StrategyRegistry 컴파일됨" do
      assert Code.ensure_loaded?(StrategyRegistry)
    end

    test "get/1 존재" do
      assert function_exported?(StrategyRegistry, :get, 1)
    end

    test "list/2 존재" do
      assert function_exported?(StrategyRegistry, :list, 2)
    end

    test "register/1 존재" do
      assert function_exported?(StrategyRegistry, :register, 1)
    end

    test "promote/3 존재" do
      assert function_exported?(StrategyRegistry, :promote, 3)
    end

    test "demote/2 존재" do
      assert function_exported?(StrategyRegistry, :demote, 2)
    end

    test "record_validation/2 존재" do
      assert function_exported?(StrategyRegistry, :record_validation, 2)
    end
  end

  describe "status 전이 (DB 미연결 환경)" do
    test "get — 존재하지 않는 전략 → {:error, _}" do
      result = StrategyRegistry.get("nonexistent_strategy_#{:rand.uniform(999_999)}")
      assert match?({:error, _}, result)
    end

    test "list — DB 미연결 시 예외 없이 반환" do
      result = StrategyRegistry.list(nil, nil)
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end
end
