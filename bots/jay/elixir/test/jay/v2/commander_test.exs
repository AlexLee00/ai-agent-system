defmodule Jay.V2.CommanderTest do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded?(Jay.V2.Commander)
    :ok
  end

  describe "module_definition" do
    test "모듈 정의됨" do
      assert Code.ensure_loaded?(Jay.V2.Commander)
    end
  end

  describe "public_api" do
    test "daily_growth_cycle/1 export" do
      assert function_exported?(Jay.V2.Commander, :daily_growth_cycle, 1)
    end

    test "decide_formation/1 export" do
      assert function_exported?(Jay.V2.Commander, :decide_formation, 1)
    end

    test "analyze_team_health/1 export" do
      assert function_exported?(Jay.V2.Commander, :analyze_team_health, 1)
    end

    test "publish_cross_team/4 export" do
      assert function_exported?(Jay.V2.Commander, :publish_cross_team, 4)
    end

    test "review_autonomy/1 export" do
      assert function_exported?(Jay.V2.Commander, :review_autonomy, 1)
    end

    test "weekly_review/1 export" do
      assert function_exported?(Jay.V2.Commander, :weekly_review, 1)
    end
  end

  describe "unknown_team" do
    test "알 수 없는 팀은 error 반환" do
      assert {:error, :unknown_team} = Jay.V2.Commander.analyze_team_health(:nonexistent)
    end
  end
end
