defmodule Darwin.V2.Memory.L1Test do
  use ExUnit.Case, async: false

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Memory.L1)
    :ok
  end

  describe "module_definition" do
    test "L1 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Darwin.V2.Memory.L1)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(Darwin.V2.Memory.L1, :start_link, 1)
    end

    test "put/2 함수 export" do
      assert function_exported?(Darwin.V2.Memory.L1, :put, 2)
    end

    test "get/1 함수 export" do
      assert function_exported?(Darwin.V2.Memory.L1, :get, 1)
    end

    test "all/0 함수 export" do
      assert function_exported?(Darwin.V2.Memory.L1, :all, 0)
    end

    test "clear/0 함수 export" do
      assert function_exported?(Darwin.V2.Memory.L1, :clear, 0)
    end

    test "flush_to_l2/1 함수 export" do
      assert function_exported?(Darwin.V2.Memory.L1, :flush_to_l2, 1)
    end

    test "store/3 함수 export" do
      assert function_exported?(Darwin.V2.Memory.L1, :store, 3)
    end

    test "recall/2 함수 export" do
      assert function_exported?(Darwin.V2.Memory.L1, :recall, 2)
    end
  end

  describe "moduledoc" do
    test "모듈 문서 존재" do
      {:docs_v1, _, _, _, module_doc, _, _} = Code.fetch_docs(Darwin.V2.Memory.L1)
      assert module_doc != :none
    end
  end
end
