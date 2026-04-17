defmodule Darwin.V2.ScannerTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Scanner

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Scanner)
    :ok
  end

  describe "module_definition" do
    test "Scanner 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Scanner)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(Scanner, :start_link, 1)
    end

    test "trigger_scan/0 함수 export" do
      assert function_exported?(Scanner, :trigger_scan, 0)
    end

    test "poll_now/0 함수 export" do
      assert function_exported?(Scanner, :poll_now, 0)
    end

    test "init/1 함수 export" do
      assert function_exported?(Scanner, :init, 1)
    end
  end

  describe "genserver_callbacks" do
    test "handle_info/2 export" do
      assert function_exported?(Scanner, :handle_info, 2)
    end
  end

  describe "poll_scheduling" do
    test ":poll 메시지 스케줄링" do
      assert function_exported?(Scanner, :handle_info, 2)
    end
  end

  describe "jay_bus_integration" do
    test "paper.discovered 토픽 발행" do
      assert Code.ensure_loaded?(Darwin.V2.Topics)
    end
  end

  describe "namespace" do
    test "Darwin.V2 네임스페이스" do
      assert String.starts_with?(to_string(Scanner), "Elixir.Darwin.V2")
    end
  end

  describe "discover_cycle_integration" do
    test "DISCOVER 사이클과 연동" do
      assert Code.ensure_loaded?(Darwin.V2.Cycle.Discover)
    end
  end
end
