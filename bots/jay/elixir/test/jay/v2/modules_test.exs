defmodule Jay.V2.ModulesTest do
  use ExUnit.Case, async: true

  @modules [
    Jay.V2.AutonomyController,
    Jay.V2.CommandEnvelope,
    Jay.V2.CommandTracker,
    Jay.V2.CrossTeamRouter,
    Jay.V2.DailyBriefing,
    Jay.V2.DecisionEngine,
    Jay.V2.GrowthCycle,
    Jay.V2.N8nBridge,
    Jay.V2.TeamConnector,
    Jay.V2.Topics,
    Jay.V2.WeeklyReport,
    Jay.V2.Supervisor
  ]

  setup_all do
    Enum.each(@modules, &Code.ensure_loaded?/1)
    :ok
  end

  describe "module_definitions" do
    for mod <- [
      Jay.V2.AutonomyController,
      Jay.V2.CommandEnvelope,
      Jay.V2.CommandTracker,
      Jay.V2.CrossTeamRouter,
      Jay.V2.DailyBriefing,
      Jay.V2.DecisionEngine,
      Jay.V2.GrowthCycle,
      Jay.V2.N8nBridge,
      Jay.V2.TeamConnector,
      Jay.V2.Topics,
      Jay.V2.WeeklyReport,
      Jay.V2.Supervisor
    ] do
      test "#{mod} 정의됨" do
        assert Code.ensure_loaded?(unquote(mod))
      end
    end
  end

  describe "public_api" do
    test "AutonomyController.get_phase/0 export" do
      assert function_exported?(Jay.V2.AutonomyController, :get_phase, 0)
    end

    test "AutonomyController.get_status/0 export" do
      assert function_exported?(Jay.V2.AutonomyController, :get_status, 0)
    end

    test "CommandEnvelope.build/5 export" do
      assert function_exported?(Jay.V2.CommandEnvelope, :build, 5)
    end

    test "CommandTracker.issued/4 export" do
      assert function_exported?(Jay.V2.CommandTracker, :issued, 4)
    end

    test "CrossTeamRouter.start_link/1 export" do
      assert function_exported?(Jay.V2.CrossTeamRouter, :start_link, 1)
    end

    test "DailyBriefing.generate/2 export" do
      assert function_exported?(Jay.V2.DailyBriefing, :generate, 2)
    end

    test "DecisionEngine.evaluate/2 export" do
      assert function_exported?(Jay.V2.DecisionEngine, :evaluate, 2)
    end

    test "GrowthCycle.run_cycle/0 export" do
      assert function_exported?(Jay.V2.GrowthCycle, :run_cycle, 0)
    end

    test "N8nBridge.get_status/0 export" do
      assert function_exported?(Jay.V2.N8nBridge, :get_status, 0)
    end

    test "TeamConnector.collect_all/0 export" do
      assert function_exported?(Jay.V2.TeamConnector, :collect_all, 0)
    end

    test "TeamConnector.all_teams/0 export" do
      assert function_exported?(Jay.V2.TeamConnector, :all_teams, 0)
    end

    test "Topics.broadcast/2 export" do
      assert function_exported?(Jay.V2.Topics, :broadcast, 2)
    end

    test "Topics.all_topics/0 export" do
      assert function_exported?(Jay.V2.Topics, :all_topics, 0)
    end

    test "WeeklyReport.run/0 export" do
      assert function_exported?(Jay.V2.WeeklyReport, :run, 0)
    end

    test "Supervisor.start_link/1 export" do
      assert function_exported?(Jay.V2.Supervisor, :start_link, 1)
    end
  end

  describe "pure_function_behavior" do
    test "CommandEnvelope.build/5 반환 맵 형태" do
      result = Jay.V2.CommandEnvelope.build(:route, :jay, :sigma, %{}, [])
      assert is_map(result)
    end

    test "CommandEnvelope.summary/1 반환 문자열" do
      envelope = Jay.V2.CommandEnvelope.build(:route, :jay, :sigma, %{}, [])
      summary = Jay.V2.CommandEnvelope.summary(envelope)
      assert is_binary(summary)
    end

    test "DailyBriefing.generate/2 반환 문자열" do
      result = Jay.V2.DailyBriefing.generate(%{}, "2026-04-18")
      assert is_binary(result)
    end

    test "Topics.all_topics/0 반환 목록" do
      topics = Jay.V2.Topics.all_topics()
      assert is_list(topics)
      assert length(topics) > 0
    end
  end
end
