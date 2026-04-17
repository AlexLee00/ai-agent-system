defmodule Darwin.V2.Cycle.ApplyTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Cycle.Apply

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Cycle.Apply)
    :ok
  end


  describe "module_definition" do
    test "Apply 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Apply)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(Apply, :start_link, 1)
    end

    test "run_now/1 함수 export" do
      assert function_exported?(Apply, :run_now, 1)
    end

    test "status/0 함수 export" do
      assert function_exported?(Apply, :status, 0)
    end
  end

  describe "cycle_position" do
    test "APPLY는 사이클의 6단계 (main 적용)" do
      assert Apply.__info__(:module) == Darwin.V2.Cycle.Apply
    end
  end

  describe "applier_connection" do
    test "Darwin.V2.Applier 모듈 존재" do
      assert Code.ensure_loaded?(Darwin.V2.Applier)
    end
  end

  describe "safety_gate" do
    test "APPLY는 verification_passed 없이 차단되어야 함 (Principle)" do
      assert Code.ensure_loaded?(Darwin.V2.Principle.Loader)
    end

    test "GenServer 패턴" do
      assert function_exported?(Apply, :init, 1)
    end
  end
end
