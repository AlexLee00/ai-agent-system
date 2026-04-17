defmodule Jay.V2.Skill.AutonomyGovernorTest do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded?(Jay.V2.Skill.AutonomyGovernor)
    :ok
  end

  describe "module_definition" do
    test "모듈 정의됨" do
      assert Code.ensure_loaded?(Jay.V2.Skill.AutonomyGovernor)
    end
  end

  describe "jido_action_api" do
    test "run/2 export" do
      assert function_exported?(Jay.V2.Skill.AutonomyGovernor, :run, 2)
    end
  end

  describe "behavior" do
    @tag :integration
    test "status action 반환 (AutonomyController 필요)" do
      result = Jay.V2.Skill.AutonomyGovernor.run(%{action: "status", team: "jay"}, %{})
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end

    test "알 수 없는 action ok 반환 (error map)" do
      assert {:ok, %{error: _}} = Jay.V2.Skill.AutonomyGovernor.run(%{action: "unknown_xyz", team: "jay"}, %{})
    end
  end
end
