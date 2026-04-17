defmodule Jay.V2.Skill.FormationDecisionTest do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded?(Jay.V2.Skill.FormationDecision)
    :ok
  end

  describe "module_definition" do
    test "모듈 정의됨" do
      assert Code.ensure_loaded?(Jay.V2.Skill.FormationDecision)
    end
  end

  describe "jido_action_api" do
    test "run/2 export" do
      assert function_exported?(Jay.V2.Skill.FormationDecision, :run, 2)
    end
  end

  describe "behavior" do
    test "빈 team_states로 formation 반환" do
      assert {:ok, result} = Jay.V2.Skill.FormationDecision.run(
        %{date: "2026-04-18", team_states: []},
        %{}
      )
      assert is_map(result)
      assert Map.has_key?(result, :date)
    end

    test "sigma 목표 포함" do
      {:ok, result} = Jay.V2.Skill.FormationDecision.run(%{date: "2026-04-18", team_states: []}, %{})
      assert Map.has_key?(result, :sigma)
    end

    test "darwin 목표 포함" do
      {:ok, result} = Jay.V2.Skill.FormationDecision.run(%{date: "2026-04-18", team_states: []}, %{})
      assert Map.has_key?(result, :darwin)
    end
  end
end
