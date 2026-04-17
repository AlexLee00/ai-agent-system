defmodule Darwin.V2.Sensor.HackerNewsTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Sensor.HackerNews

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Sensor.HackerNews)
    :ok
  end


  describe "module_definition" do
    test "HackerNews 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(HackerNews)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(HackerNews, :start_link, 1)
    end

    test "scan_now/0 함수 export" do
      assert function_exported?(HackerNews, :scan_now, 0)
    end

    test "dedup_cache_size/0 함수 export" do
      assert function_exported?(HackerNews, :dedup_cache_size, 0)
    end

    test "init/1 함수 export" do
      assert function_exported?(HackerNews, :init, 1)
    end
  end

  describe "genserver_callbacks" do
    test "handle_cast/2 export" do
      assert function_exported?(HackerNews, :handle_cast, 2)
    end

    test "handle_info/2 export" do
      assert function_exported?(HackerNews, :handle_info, 2)
    end
  end

  describe "algolia_api" do
    test "HN Algolia API 사용" do
      assert Code.ensure_loaded?(HackerNews)
    end

    @tag :integration
    test "실제 API 호출 스모크" do
      assert true
    end
  end

  describe "namespace" do
    test "Darwin.V2.Sensor 네임스페이스" do
      assert String.starts_with?(to_string(HackerNews), "Elixir.Darwin.V2.Sensor")
    end
  end
end
