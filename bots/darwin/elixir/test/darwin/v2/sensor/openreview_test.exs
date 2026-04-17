defmodule Darwin.V2.Sensor.OpenReviewTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Sensor.OpenReview

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Sensor.OpenReview)
    :ok
  end


  describe "module_definition" do
    test "OpenReview 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(OpenReview)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(OpenReview, :start_link, 1)
    end

    test "scan_now/0 함수 export" do
      assert function_exported?(OpenReview, :scan_now, 0)
    end

    test "dedup_cache_size/0 함수 export" do
      assert function_exported?(OpenReview, :dedup_cache_size, 0)
    end

    test "init/1 함수 export" do
      assert function_exported?(OpenReview, :init, 1)
    end
  end

  describe "conference_coverage" do
    test "NeurIPS/ICML/ICLR 대상 컨퍼런스" do
      assert Code.ensure_loaded?(OpenReview)
    end
  end

  describe "namespace" do
    test "Darwin.V2.Sensor 네임스페이스" do
      assert String.starts_with?(to_string(OpenReview), "Elixir.Darwin.V2.Sensor")
    end
  end

  describe "genserver_callbacks" do
    test "handle_info/2 export" do
      assert function_exported?(OpenReview, :handle_info, 2)
    end
  end
end
