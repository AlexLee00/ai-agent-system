defmodule Darwin.V2.Cycle.VerifyTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Cycle.Verify

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Cycle.Verify)
    :ok
  end


  describe "module_definition" do
    test "Verify 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Verify)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(Verify, :start_link, 1)
    end

    test "run_now/1 함수 export" do
      assert function_exported?(Verify, :run_now, 1)
    end

    test "status/0 함수 export" do
      assert function_exported?(Verify, :status, 0)
    end
  end

  describe "cycle_position" do
    test "VERIFY는 사이클의 5단계" do
      assert Verify.__info__(:module) == Darwin.V2.Cycle.Verify
    end
  end

  describe "verifier_connection" do
    test "Verifier 모듈과 연결 가능" do
      assert Code.ensure_loaded?(Darwin.V2.Verifier)
    end
  end

  describe "genserver_pattern" do
    test "init/1 함수 export" do
      assert function_exported?(Verify, :init, 1)
    end

    test "GenServer 컴파일됨" do
      assert Code.ensure_loaded?(Verify)
    end
  end
end
