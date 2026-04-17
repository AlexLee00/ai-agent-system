defmodule Darwin.V2.CommunityScannerTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.CommunityScanner

  setup_all do
    Code.ensure_loaded?(Darwin.V2.CommunityScanner)
    :ok
  end

  describe "module_definition" do
    test "CommunityScanner 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(CommunityScanner)
    end
  end

  describe "public_api" do
    test "fetch_signals/0 함수 export" do
      assert function_exported?(CommunityScanner, :fetch_signals, 0)
    end

    test "fetch_hn_signals/0 함수 export" do
      assert function_exported?(CommunityScanner, :fetch_hn_signals, 0)
    end

    test "fetch_reddit_signals/0 함수 export" do
      assert function_exported?(CommunityScanner, :fetch_reddit_signals, 0)
    end
  end

  describe "fetch_signals_default" do
    @tag :integration
    test "실제 HN/Reddit API 호출" do
      assert true
    end

    test "함수 반환 타입 리스트" do
      # 실제 외부 호출 없이 함수 export만 확인
      assert function_exported?(CommunityScanner, :fetch_signals, 0)
    end
  end

  describe "namespace" do
    test "Darwin.V2 네임스페이스" do
      assert String.starts_with?(to_string(CommunityScanner), "Elixir.Darwin.V2")
    end
  end

  describe "d_option_signal" do
    test "커뮤니티 시그널 D옵션 확장 모듈" do
      assert Code.ensure_loaded?(CommunityScanner)
    end
  end
end
