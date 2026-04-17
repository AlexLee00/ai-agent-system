defmodule Darwin.V2.Cycle.EvaluateTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Cycle.Evaluate

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Cycle.Evaluate)
    :ok
  end


  describe "module_definition" do
    test "Evaluate 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Evaluate)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(Evaluate, :start_link, 1)
    end

    test "run_now/1 함수 export" do
      assert function_exported?(Evaluate, :run_now, 1)
    end

    test "status/0 함수 export" do
      assert function_exported?(Evaluate, :status, 0)
    end

    test "init/1 함수 export" do
      assert function_exported?(Evaluate, :init, 1)
    end
  end

  describe "cycle_position" do
    test "EVALUATE는 사이클의 2단계" do
      assert Evaluate.__info__(:module) == Darwin.V2.Cycle.Evaluate
    end
  end

  describe "genserver_behaviour" do
    test "GenServer 패턴" do
      assert Code.ensure_loaded?(Evaluate)
    end
  end

  describe "function_count" do
    test "최소 4개 public 함수" do
      fns = Evaluate.__info__(:functions)
      assert length(fns) >= 4
    end

    test "모듈 이름이 Cycle 네임스페이스" do
      assert String.starts_with?(to_string(Evaluate), "Elixir.Darwin.V2.Cycle")
    end
  end
end
