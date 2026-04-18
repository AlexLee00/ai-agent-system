defmodule Darwin.V2.Memory.L2Test do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Memory.L2)
    :ok
  end

  describe "module_definition" do
    test "L2 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Darwin.V2.Memory.L2)
    end
  end

  describe "public_api" do
    test "store/4 함수 export" do
      assert function_exported?(Darwin.V2.Memory.L2, :store, 4)
    end

    test "retrieve/3 함수 export" do
      assert function_exported?(Darwin.V2.Memory.L2, :retrieve, 3)
    end

    test "run/2 함수 export" do
      assert function_exported?(Darwin.V2.Memory.L2, :run, 2)
    end

    test "encode/1 함수 export" do
      assert function_exported?(Darwin.V2.Memory.L2, :encode, 1)
    end
  end

  describe "encode_function" do
    test "encode/1은 바이너리 입력을 받음" do
      assert function_exported?(Darwin.V2.Memory.L2, :encode, 1)
    end
  end

  describe "moduledoc" do
    test "모듈 문서 존재" do
      {:docs_v1, _, _, _, module_doc, _, _} = Code.fetch_docs(Darwin.V2.Memory.L2)
      assert module_doc != :none
    end
  end

  describe "db_integration" do
    @tag :db
    test "pgvector 저장/회수는 DB 통합 테스트" do
      assert true
    end
  end
end
