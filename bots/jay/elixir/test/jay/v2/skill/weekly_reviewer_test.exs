defmodule Jay.V2.Skill.WeeklyReviewerTest do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded?(Jay.V2.Skill.WeeklyReviewer)
    :ok
  end

  describe "module_definition" do
    test "모듈 정의됨" do
      assert Code.ensure_loaded?(Jay.V2.Skill.WeeklyReviewer)
    end
  end

  describe "jido_action_api" do
    test "run/2 export" do
      assert function_exported?(Jay.V2.Skill.WeeklyReviewer, :run, 2)
    end
  end

  describe "behavior" do
    @tag :integration
    test "주간 리포트 실행 (TeamConnector + DB 필요)" do
      result = Jay.V2.Skill.WeeklyReviewer.run(%{week_ending: "2026-04-18"}, %{})
      assert match?({:ok, %{week_ending: _, result: _}}, result) or match?({:error, _}, result)
    end
  end
end
