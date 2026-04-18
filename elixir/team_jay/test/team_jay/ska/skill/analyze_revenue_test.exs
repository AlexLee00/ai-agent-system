defmodule TeamJay.Ska.Skill.AnalyzeRevenueTest do
  use ExUnit.Case, async: true
  alias TeamJay.Ska.Skill.AnalyzeRevenue

  describe "metadata/0" do
    test "스킬 메타데이터 반환" do
      meta = AnalyzeRevenue.metadata()
      assert meta.name == :analyze_revenue
      assert meta.domain == :analytics
    end
  end

  describe "run/2" do
    test "Kill Switch OFF 시 python_skill_disabled 반환" do
      System.put_env("SKA_PYTHON_SKILL_ENABLED", "false")
      assert {:error, :python_skill_disabled} = AnalyzeRevenue.run(%{period_days: 7}, %{})
    end
  end
end
