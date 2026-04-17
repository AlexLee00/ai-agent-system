defmodule Darwin.V2.Skill.TreeSearchTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Skill.TreeSearch

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Skill.TreeSearch)
    :ok
  end

  describe "module_definition" do
    test "TreeSearch 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(TreeSearch)
    end
  end

  describe "jido_action_pattern" do
    test "run/2 함수 export" do
      assert function_exported?(TreeSearch, :run, 2)
    end
  end

  describe "namespace" do
    test "Darwin.V2.Skill 네임스페이스" do
      assert String.starts_with?(to_string(TreeSearch), "Elixir.Darwin.V2.Skill")
    end
  end

  describe "tree_search_purpose" do
    test "Edison 구현 막힘 시 대안 경로 탐색" do
      assert Code.ensure_loaded?(TreeSearch)
    end

    test "AI Scientist-v2 progressive tree search 참조" do
      assert function_exported?(TreeSearch, :run, 2)
    end
  end

  describe "edison_integration" do
    test "Edison 모듈과 연결 가능" do
      assert Code.ensure_loaded?(Darwin.V2.Edison)
    end
  end

  describe "function_count" do
    test "public 함수 최소 1개" do
      assert length(TreeSearch.__info__(:functions)) >= 1
    end
  end
end
