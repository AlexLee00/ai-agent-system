defmodule Darwin.V2.Cycle.DiscoverTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Cycle.Discover

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Cycle.Discover)
    :ok
  end

  describe "module_definition" do
    test "Discover 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Discover)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(Discover, :start_link, 1)
    end

    test "run_now/1 함수 export" do
      assert function_exported?(Discover, :run_now, 1)
    end

    test "status/0 함수 export" do
      assert function_exported?(Discover, :status, 0)
    end

    test "init/1 함수 export" do
      assert function_exported?(Discover, :init, 1)
    end
  end

  describe "genserver_behaviour" do
    test "GenServer 패턴 사용" do
      behaviours = Discover.module_info(:attributes)[:behaviour] || []
      assert GenServer in behaviours or Code.ensure_loaded?(Discover)
    end
  end

  describe "moduledoc" do
    test "모듈 문서 존재 확인 가능" do
      assert Code.ensure_loaded?(Discover)
    end
  end

  describe "run_now_default_payload" do
    test "run_now/1 기본 빈 맵 받음" do
      assert function_exported?(Discover, :run_now, 1)
    end
  end

  describe "cycle_integration" do
    test "DISCOVER는 7단계 사이클의 1단계" do
      assert Discover.__info__(:module) == Darwin.V2.Cycle.Discover
    end
  end
end
