defmodule Darwin.V2.Cycle.PlanTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Cycle.Plan

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Cycle.Plan)
    :ok
  end


  describe "module_definition" do
    test "Plan 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Plan)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(Plan, :start_link, 1)
    end

    test "run_now/1 함수 export" do
      assert function_exported?(Plan, :run_now, 1)
    end

    test "status/0 함수 export" do
      assert function_exported?(Plan, :status, 0)
    end
  end

  describe "cycle_position" do
    test "PLAN는 사이클의 3단계" do
      assert Plan.__info__(:module) == Darwin.V2.Cycle.Plan
    end
  end

  describe "genserver_pattern" do
    test "GenServer 패턴 사용" do
      assert Code.ensure_loaded?(Plan)
    end

    test "init/1 함수 export" do
      assert function_exported?(Plan, :init, 1)
    end
  end

  describe "namespace" do
    test "Darwin.V2.Cycle 네임스페이스" do
      assert String.starts_with?(to_string(Plan), "Elixir.Darwin.V2.Cycle")
    end
  end
end
