defmodule Darwin.V2.IntegrationTest do
  use ExUnit.Case, async: true

  describe "cycle_seven_steps" do
    test "DISCOVER 모듈 존재" do
      assert Code.ensure_loaded?(Darwin.V2.Cycle.Discover)
    end

    test "EVALUATE 모듈 존재" do
      assert Code.ensure_loaded?(Darwin.V2.Cycle.Evaluate)
    end

    test "PLAN 모듈 존재" do
      assert Code.ensure_loaded?(Darwin.V2.Cycle.Plan)
    end

    test "IMPLEMENT 모듈 존재" do
      assert Code.ensure_loaded?(Darwin.V2.Cycle.Implement)
    end

    test "VERIFY 모듈 존재" do
      assert Code.ensure_loaded?(Darwin.V2.Cycle.Verify)
    end

    test "APPLY 모듈 존재" do
      assert Code.ensure_loaded?(Darwin.V2.Cycle.Apply)
    end

    test "LEARN 모듈 존재" do
      assert Code.ensure_loaded?(Darwin.V2.Cycle.Learn)
    end
  end

  describe "autonomy_10_elements" do
    test "요소 1: LLM Selector" do
      assert Code.ensure_loaded?(Darwin.V2.LLM.Selector)
    end

    test "요소 2: LLM Recommender" do
      assert Code.ensure_loaded?(Darwin.V2.LLM.Recommender)
    end

    test "요소 3: Reflexion" do
      assert Code.ensure_loaded?(Darwin.V2.Reflexion)
    end

    test "요소 4: SelfRAG" do
      assert Code.ensure_loaded?(Darwin.V2.SelfRAG)
    end

    test "요소 5: ESPL" do
      assert Code.ensure_loaded?(Darwin.V2.ESPL)
    end

    test "요소 6: Principle.Loader" do
      assert Code.ensure_loaded?(Darwin.V2.Principle.Loader)
    end

    test "요소 7: Memory L1/L2" do
      assert Code.ensure_loaded?(Darwin.V2.Memory.L1)
      assert Code.ensure_loaded?(Darwin.V2.Memory.L2)
    end

    test "요소 8: AutonomyLevel" do
      assert Code.ensure_loaded?(Darwin.V2.AutonomyLevel)
    end

    test "요소 9: CostTracker" do
      assert Code.ensure_loaded?(Darwin.V2.LLM.CostTracker)
    end

    test "요소 10: ShadowRunner/Compare" do
      assert Code.ensure_loaded?(Darwin.V2.ShadowRunner)
      assert Code.ensure_loaded?(Darwin.V2.ShadowCompare)
    end
  end

  describe "supervisor_tree" do
    test "Darwin.V2.Supervisor 정의" do
      assert Code.ensure_loaded?(Darwin.V2.Supervisor)
    end

    test "Darwin.Application 정의" do
      assert Code.ensure_loaded?(Darwin.Application)
    end
  end

  describe "kill_switches" do
    test "KillSwitch 모듈 존재" do
      assert Code.ensure_loaded?(Darwin.V2.KillSwitch)
    end
  end

  describe "jido_skills_six" do
    test "PaperSynthesis" do
      assert Code.ensure_loaded?(Darwin.V2.Skill.PaperSynthesis)
    end

    test "Replication" do
      assert Code.ensure_loaded?(Darwin.V2.Skill.Replication)
    end

    test "ResourceAnalyst" do
      assert Code.ensure_loaded?(Darwin.V2.Skill.ResourceAnalyst)
    end

    test "ExperimentDesign" do
      assert Code.ensure_loaded?(Darwin.V2.Skill.ExperimentDesign)
    end

    test "VlmFeedback" do
      assert Code.ensure_loaded?(Darwin.V2.Skill.VLMFeedback)
    end

    test "TreeSearch" do
      assert Code.ensure_loaded?(Darwin.V2.Skill.TreeSearch)
    end
  end

  describe "sensors_four" do
    test "ArxivRSS" do
      assert Code.ensure_loaded?(Darwin.V2.Sensor.ArxivRSS)
    end

    test "HackerNews" do
      assert Code.ensure_loaded?(Darwin.V2.Sensor.HackerNews)
    end

    test "Reddit" do
      assert Code.ensure_loaded?(Darwin.V2.Sensor.Reddit)
    end

    test "OpenReview" do
      assert Code.ensure_loaded?(Darwin.V2.Sensor.OpenReview)
    end
  end

  describe "mcp_modules" do
    test "MCP Client" do
      assert Code.ensure_loaded?(Darwin.V2.MCP.Client)
    end

    test "MCP Server" do
      assert Code.ensure_loaded?(Darwin.V2.MCP.Server)
    end
  end
end
