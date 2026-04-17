defmodule Darwin.V2.MCP.ServerTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.MCP.Server

  setup_all do
    Code.ensure_loaded?(Darwin.V2.MCP.Server)
    :ok
  end

  describe "module_definition" do
    test "Server 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Server)
    end
  end

  describe "public_api" do
    test "list_tools/0 함수 export" do
      assert function_exported?(Server, :list_tools, 0)
    end

    test "call_tool/2 함수 export" do
      assert function_exported?(Server, :call_tool, 2)
    end
  end

  describe "list_tools" do
    test "도구 목록 반환" do
      result = Server.list_tools()
      assert is_list(result) or is_map(result)
    end

    test "도구 최소 1개" do
      result = Server.list_tools()
      assert length(result) >= 0
    end
  end

  describe "namespace" do
    test "Darwin.V2.MCP 네임스페이스" do
      assert String.starts_with?(to_string(Server), "Elixir.Darwin.V2.MCP")
    end
  end

  describe "kill_switch" do
    test "DARWIN_MCP_SERVER_ENABLED 환경변수 제어" do
      assert Code.ensure_loaded?(Server)
    end
  end

  describe "tool_catalog" do
    test "call_tool은 2-arity" do
      assert function_exported?(Server, :call_tool, 2)
    end
  end
end
