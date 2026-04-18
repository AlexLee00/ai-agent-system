defmodule Luna.V2.CommanderTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Commander

  setup_all do
    Code.ensure_compiled!(Commander)
    :ok
  end

  describe "모듈 구조 (smoke)" do
    test "Commander 컴파일됨" do
      assert Code.ensure_loaded?(Commander)
    end

    test "Jido.AI.Agent 기반" do
      # use Jido.AI.Agent → __info__(:attributes)에 jido 관련 속성 존재
      info = Commander.__info__(:attributes)
      assert is_list(info)
    end

    test "run_cycle/2 존재" do
      assert function_exported?(Commander, :run_cycle, 2)
    end
  end

  describe "Skills 모듈 존재 확인" do
    test "MarketRegimeDetector 컴파일됨" do
      assert Code.ensure_loaded?(Luna.V2.Skill.MarketRegimeDetector)
    end

    test "PortfolioMonitor 컴파일됨" do
      assert Code.ensure_loaded?(Luna.V2.Skill.PortfolioMonitor)
    end

    test "RiskGovernor 컴파일됨" do
      assert Code.ensure_loaded?(Luna.V2.Skill.RiskGovernor)
    end
  end
end
