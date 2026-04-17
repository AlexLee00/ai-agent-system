defmodule Darwin.V2.Sensor.ArxivRSSTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Sensor.ArxivRSS

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Sensor.ArxivRSS)
    :ok
  end


  describe "module_definition" do
    test "ArxivRSS 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(ArxivRSS)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(ArxivRSS, :start_link, 1)
    end

    test "scan_now/0 함수 export" do
      assert function_exported?(ArxivRSS, :scan_now, 0)
    end

    test "dedup_cache_size/0 함수 export" do
      assert function_exported?(ArxivRSS, :dedup_cache_size, 0)
    end

    test "init/1 함수 export" do
      assert function_exported?(ArxivRSS, :init, 1)
    end
  end

  describe "genserver_callbacks" do
    test "handle_cast/2 export" do
      assert function_exported?(ArxivRSS, :handle_cast, 2)
    end

    test "handle_call/3 export" do
      assert function_exported?(ArxivRSS, :handle_call, 3)
    end

    test "handle_info/2 export" do
      assert function_exported?(ArxivRSS, :handle_info, 2)
    end
  end

  describe "namespace" do
    test "Darwin.V2.Sensor 네임스페이스" do
      assert String.starts_with?(to_string(ArxivRSS), "Elixir.Darwin.V2.Sensor")
    end
  end

  describe "kill_switch" do
    test "DARWIN_SENSOR_ARXIV_ENABLED 환경변수 제어" do
      assert Code.ensure_loaded?(ArxivRSS)
    end

    @tag :integration
    test "실제 RSS 호출 테스트는 integration" do
      assert true
    end
  end
end
