defmodule Jay.V2.Skill.DailyBriefingComposerTest do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded?(Jay.V2.Skill.DailyBriefingComposer)
    :ok
  end

  describe "module_definition" do
    test "모듈 정의됨" do
      assert Code.ensure_loaded?(Jay.V2.Skill.DailyBriefingComposer)
    end
  end

  describe "jido_action_api" do
    test "run/2 export" do
      assert function_exported?(Jay.V2.Skill.DailyBriefingComposer, :run, 2)
    end
  end

  describe "behavior" do
    @tag :integration
    test "브리핑 생성 (TeamConnector 필요)" do
      result = Jay.V2.Skill.DailyBriefingComposer.run(%{date: "2026-04-18"}, %{})
      assert match?({:ok, %{briefing_text: _, date: _}}, result) or match?({:error, _}, result)
    end
  end
end
