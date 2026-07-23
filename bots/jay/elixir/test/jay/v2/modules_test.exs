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

    test "AutonomyController fails closed when clean-day evidence is unavailable" do
      assert Jay.V2.AutonomyController.classify_escalation_result(
               {:ok, %{"rows" => [%{"cnt" => 0}]}}
             ) == :clean

      assert Jay.V2.AutonomyController.classify_escalation_result(
               {:ok, %{"rows" => [%{"cnt" => 2}]}}
             ) == :escalated

      assert Jay.V2.AutonomyController.classify_escalation_result({:error, :timeout}) == :unknown

      today = ~D[2026-07-24]

      assert Jay.V2.AutonomyController.clean_day_due?(
               %Jay.V2.AutonomyController{last_clean_date: nil},
               today
             )

      refute Jay.V2.AutonomyController.clean_day_due?(
               %Jay.V2.AutonomyController{last_clean_date: today},
               today
             )
    end

    test "CommandEnvelope.build/5 export" do
      assert function_exported?(Jay.V2.CommandEnvelope, :build, 5)
    end

    test "CommandTracker.issued/4 export" do
      assert function_exported?(Jay.V2.CommandTracker, :issued, 4)
    end

    test "CommandTracker.suppressed/4 export" do
      assert function_exported?(Jay.V2.CommandTracker, :suppressed, 4)
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

    test "GrowthCycle.run_cycle_sync/1 export" do
      assert function_exported?(Jay.V2.GrowthCycle, :run_cycle_sync, 1)
    end

    test "TeamConnector.collect_all/0 export" do
      assert function_exported?(Jay.V2.TeamConnector, :collect_all, 0)
    end

    test "TeamConnector.all_teams/0 export" do
      assert function_exported?(Jay.V2.TeamConnector, :all_teams, 0)
    end

    test "TeamConnector.active_teams/0 export" do
      assert function_exported?(Jay.V2.TeamConnector, :active_teams, 0)
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

    test "DailyBriefing.generate/2 accepts string agent scores from DB adapters" do
      result =
        Jay.V2.DailyBriefing.generate(
          %{
            platform: %{
              metric_type: :agent_health,
              active_agents: 0,
              avg_score: "0.0",
              low_score_agents: 0
            }
          },
          "2026-05-21"
        )

      assert result =~ "평균점수 0.0"
    end

    test "Topics.all_topics/0 반환 목록" do
      topics = Jay.V2.Topics.all_topics()
      assert is_list(topics)
      assert length(topics) > 0
    end
  end

  describe "launchd_contracts" do
    test "ai.jay.growth invokes synchronous GrowthCycle runner without team_jay node collision" do
      plist =
        Path.expand("../../../../launchd/ai.jay.growth.plist", __DIR__)
        |> File.read!()

      assert plist =~ "jay.growth_cycle.run"
      refute plist =~ "<string>team_jay</string>"
      refute plist =~ "Jay.V2.Commander.daily_growth_cycle()"
      refute plist =~ "mix</string>\n\t\t<string>run</string>"

      task_source =
        Path.expand(
          "../../../../../../elixir/team_jay/lib/mix/tasks/jay.growth_cycle.run.ex",
          __DIR__
        )
        |> File.read!()

      assert task_source =~ "start_process!(Jay.V2.AutonomyController)"
      assert task_source =~ ~s("--actions")
      assert task_source =~ ~s("--notify")
      assert task_source =~ ~s("--record-clean-day")
      assert task_source =~ "execute_actions: false"
      assert task_source =~ "notify: false"
      assert task_source =~ "record_clean_day: false"
    end

    test "Jay test wrapper never starts the integrated TeamJay application" do
      mix_source =
        Path.expand("../../../mix.exs", __DIR__)
        |> File.read!()

      assert mix_source =~ "mix test --no-start"
    end

    test "GrowthCycle records a completed event with briefing length for dashboard seed" do
      source =
        Path.expand("../../../lib/jay/v2/growth_cycle.ex", __DIR__)
        |> File.read!()

      assert source =~ ~s(event_type: "growth_cycle.completed")
      assert source =~ "briefing_len: String.length(briefing)"
      assert source =~ "cycle_id_for_date(date)"
    end

    test "AutonomyController startup does not bootstrap schema or persist an unchanged snapshot" do
      source =
        Path.expand("../../../lib/jay/v2/autonomy_controller.ex", __DIR__)
        |> File.read!()

      refute source =~ "CREATE SCHEMA"
      refute source =~ "CREATE TABLE"
      refute source =~ "state = load_state_from_db()\n    save_state_to_db(state)"
    end
  end

  describe "team_catalog_contracts" do
    test "active teams match the six current child teams and exclude retired judgment" do
      assert Jay.V2.TeamConnector.active_teams() == [:sigma, :darwin, :luna, :blog, :ska, :claude]
      refute :judgment in Jay.V2.TeamConnector.active_teams()
      assert :sigma in Jay.V2.TeamConnector.all_teams()
      assert :platform in Jay.V2.TeamConnector.all_teams()
    end

    test "collection summary counts only successful team reads" do
      assert Jay.V2.TeamConnector.collection_summary(%{
               luna: %{metric_type: :trading_ops},
               sigma: %{metric_type: :knowledge_ops},
               darwin: nil
             }) == %{
               attempted: 3,
               succeeded: 2,
               failed: [:darwin]
             }
    end

    test "missing Sigma evidence is a failed read, not a zero-valued success" do
      assert Jay.V2.TeamConnector.build_knowledge_metrics(nil) == nil

      assert Jay.V2.TeamConnector.build_knowledge_metrics(%{
               "total_entries" => 10,
               "entries_7d" => 2,
               "validated" => 1,
               "contradicted" => 3
             }) == %{
               metric_type: :knowledge_ops,
               total_entries: 10,
               entries_7d: 2,
               validated: 1,
               contradicted: 3
             }
    end
  end

  describe "alarm_delivery_contracts" do
    test "suppressed alarms are not acknowledged and unknown results fail closed" do
      assert Jay.V2.CrossTeamRouter.classify_dispatch_result({:ok, %{suppressed: true}}) ==
               {:suppressed, %{suppressed: true}}

      assert Jay.V2.CrossTeamRouter.classify_dispatch_result({:ok, %{accepted: true}}) ==
               {:acknowledged, %{accepted: true}}

      assert Jay.V2.CrossTeamRouter.classify_dispatch_result({:error, :closed}) ==
               {:failed, :closed}

      assert Jay.V2.CrossTeamRouter.classify_dispatch_result(:unexpected) ==
               {:failed, :unexpected}
    end
  end

  describe "scheduler_ownership_contracts" do
    test "Dexter launchd ownership keeps the embedded periodic scheduler off by default" do
      refute TeamJay.Claude.Dexter.TestRunner.scheduler_enabled?(%{})

      assert TeamJay.Claude.Dexter.TestRunner.scheduler_enabled?(%{
               "TEAM_JAY_DEXTER_SCHEDULER_ENABLED" => "true"
             })
    end
  end
end
