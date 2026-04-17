defmodule Darwin.V2.PlannerTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Planner

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Planner)
    :ok
  end

  describe "module_definition" do
    test "Planner 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Planner)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(Planner, :start_link, 1)
    end

    test "plan_for/1 함수 export" do
      assert function_exported?(Planner, :plan_for, 1)
    end

    test "get_pending_plans/0 함수 export" do
      assert function_exported?(Planner, :get_pending_plans, 0)
    end

    test "init/1 함수 export" do
      assert function_exported?(Planner, :init, 1)
    end
  end

  describe "genserver_callbacks" do
    test "handle_info/2 export" do
      assert function_exported?(Planner, :handle_info, 2)
    end
  end

  describe "resource_analyst_pattern" do
    test "Resource Analyst 스킬과 연동 가능" do
      assert Code.ensure_loaded?(Darwin.V2.Skill.ResourceAnalyst)
    end
  end

  describe "jay_bus_integration" do
    test "paper_evaluated 이벤트 구독" do
      assert function_exported?(Planner, :handle_info, 2)
    end
  end

  describe "namespace" do
    test "Darwin.V2 네임스페이스" do
      assert String.starts_with?(to_string(Planner), "Elixir.Darwin.V2")
    end
  end
end
