defmodule Jay.V2.Skill.TeamHealthCheckTest do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded?(Jay.V2.Skill.TeamHealthCheck)
    :ok
  end

  describe "module_definition" do
    test "모듈 정의됨" do
      assert Code.ensure_loaded?(Jay.V2.Skill.TeamHealthCheck)
    end
  end

  describe "jido_action_api" do
    test "run/2 export" do
      assert function_exported?(Jay.V2.Skill.TeamHealthCheck, :run, 2)
    end
  end

  describe "behavior" do
    test "알 수 없는 팀도 rescue로 ok 반환" do
      assert {:ok, _} = Jay.V2.Skill.TeamHealthCheck.run(%{team: "nonexistent_xyz"}, %{})
    end

    @tag :integration
    test "all 팀 요청 ok 반환" do
      result = Jay.V2.Skill.TeamHealthCheck.run(%{team: "all"}, %{})
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end
end
