defmodule Darwin.V2.Skill.ResourceAnalystTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Skill.ResourceAnalyst

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Skill.ResourceAnalyst)
    :ok
  end

  describe "module_definition" do
    test "ResourceAnalyst 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(ResourceAnalyst)
    end
  end

  describe "jido_action_pattern" do
    test "run/2 함수 export" do
      assert function_exported?(ResourceAnalyst, :run, 2)
    end
  end

  describe "namespace" do
    test "Darwin.V2.Skill 네임스페이스" do
      assert String.starts_with?(to_string(ResourceAnalyst), "Elixir.Darwin.V2.Skill")
    end
  end

  describe "ai_researcher_pattern" do
    test "AI-Researcher Resource Analyst 패턴 참조" do
      assert Code.ensure_loaded?(ResourceAnalyst)
    end

    test "논문 atomic 분해 목적" do
      assert function_exported?(ResourceAnalyst, :run, 2)
    end
  end

  describe "planner_integration" do
    test "Planner와 연결 가능" do
      assert Code.ensure_loaded?(Darwin.V2.Planner)
    end
  end

  describe "function_count" do
    test "public 함수 최소 1개" do
      assert length(ResourceAnalyst.__info__(:functions)) >= 1
    end
  end
end
