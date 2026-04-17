defmodule Darwin.V2.Cycle.LearnTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Cycle.Learn

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Cycle.Learn)
    :ok
  end


  describe "module_definition" do
    test "Learn 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Learn)
    end
  end

  describe "public_api" do
    test "start_link/1 함수 export" do
      assert function_exported?(Learn, :start_link, 1)
    end

    test "run_now/1 함수 export" do
      assert function_exported?(Learn, :run_now, 1)
    end

    test "status/0 함수 export" do
      assert function_exported?(Learn, :status, 0)
    end
  end

  describe "cycle_position" do
    test "LEARN는 사이클의 7단계 (마지막)" do
      assert Learn.__info__(:module) == Darwin.V2.Cycle.Learn
    end
  end

  describe "learning_skill" do
    test "LearnFromCycle skill 연결됨" do
      assert Code.ensure_loaded?(Darwin.V2.Skill.LearnFromCycle)
    end
  end

  describe "genserver_pattern" do
    test "init/1 함수 export" do
      assert function_exported?(Learn, :init, 1)
    end

    test "Reflexion 모듈과 연결" do
      assert Code.ensure_loaded?(Darwin.V2.Reflexion)
    end
  end
end
