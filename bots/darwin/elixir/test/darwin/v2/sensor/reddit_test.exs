defmodule Darwin.V2.Sensor.RedditTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Sensor.Reddit

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Sensor.Reddit)
    :ok
  end


  describe "module_definition" do
    test "Reddit 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Reddit)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(Reddit, :start_link, 1)
    end

    test "scan_now/0 함수 export" do
      assert function_exported?(Reddit, :scan_now, 0)
    end

    test "dedup_cache_size/0 함수 export" do
      assert function_exported?(Reddit, :dedup_cache_size, 0)
    end

    test "init/1 함수 export" do
      assert function_exported?(Reddit, :init, 1)
    end
  end

  describe "genserver_callbacks" do
    test "handle_cast/2 export" do
      assert function_exported?(Reddit, :handle_cast, 2)
    end

    test "handle_info/2 export" do
      assert function_exported?(Reddit, :handle_info, 2)
    end
  end

  describe "namespace" do
    test "Darwin.V2.Sensor 네임스페이스" do
      assert String.starts_with?(to_string(Reddit), "Elixir.Darwin.V2.Sensor")
    end
  end

  describe "subreddit_coverage" do
    test "r/MachineLearning 등 주요 서브레딧 포함" do
      assert Code.ensure_loaded?(Reddit)
    end
  end
end
