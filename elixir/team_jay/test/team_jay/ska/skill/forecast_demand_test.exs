defmodule TeamJay.Ska.Skill.ForecastDemandTest do
  use ExUnit.Case, async: true
  alias TeamJay.Ska.Skill.ForecastDemand

  describe "metadata/0" do
    test "스킬 메타데이터 반환" do
      meta = ForecastDemand.metadata()
      assert meta.name == :forecast_demand
      assert meta.domain == :analytics
      assert meta.version == "1.0"
    end
  end

  describe "health_check/0" do
    test "SKA_PYTHON_SKILL_ENABLED=false 시 disabled 반환" do
      System.put_env("SKA_PYTHON_SKILL_ENABLED", "false")
      assert {:error, :python_skill_disabled} = ForecastDemand.health_check()
    end
  end

  describe "run/2" do
    test "Kill Switch OFF 시 python_skill_disabled 반환" do
      System.put_env("SKA_PYTHON_SKILL_ENABLED", "false")
      assert {:error, :python_skill_disabled} = ForecastDemand.run(%{horizon_days: 7}, %{})
    end
  end
end
