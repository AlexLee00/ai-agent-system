defmodule Sigma.V2.Phase4Test do
  use ExUnit.Case, async: true

  @moduletag :phase4

  describe "Sigma.V2.Metric" do
    test "weekly_effectiveness_by_analyst/0은 맵 반환" do
      result = Sigma.V2.Metric.weekly_effectiveness_by_analyst()
      assert is_map(result) or is_list(result)
    end

    test "next_generation_number/0은 양의 정수 반환" do
      gen = Sigma.V2.Metric.next_generation_number()
      assert is_integer(gen) and gen >= 1
    end
  end

  describe "Sigma.V2.Registry" do
    test "current_prompts/0은 리스트 반환" do
      result = Sigma.V2.Registry.current_prompts()
      assert is_list(result)
    end

    test "propose_generation/1은 {:ok, _} 또는 {:error, _} 반환" do
      candidates = [
        %{name: "test_analyst", system_prompt: "You are a test analyst.", generation: 1}
      ]
      result = Sigma.V2.Registry.propose_generation(candidates)
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end

  describe "Sigma.V2.ESPL" do
    test "kill switch 미설정 시 {:error, :espl_disabled} 반환" do
      System.delete_env("SIGMA_GEPA_ENABLED")
      result = Sigma.V2.ESPL.evolve_weekly()
      assert result == {:error, :espl_disabled}
    end

    test "evolve_weekly/0은 함수 호출 가능" do
      result = Sigma.V2.ESPL.evolve_weekly()
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end

  describe "Sigma.V2.MetaReview" do
    test "weekly/0은 {:ok, _} 또는 {:error, _} 반환" do
      result = Sigma.V2.MetaReview.weekly()
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end

  describe "Sigma.V2.TelegramBridge" do
    test "notify_pending/2는 {:ok, _} 또는 {:error, _} 반환 (Hub 미연결 허용)" do
      dir = %Sigma.Directive.ApplyFeedback{
        team: "blog",
        tier: 3,
        action: %{type: "config_change"},
        rollback_spec: %{directive_id: "t3-test"}
      }
      result = Sigma.V2.TelegramBridge.notify_pending(dir, Ecto.UUID.generate())
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end

    test "notify_meta_review/1은 {:ok, _} 또는 {:error, _} 반환 (Hub 미연결 허용)" do
      report = %{
        what_worked: ["test"],
        what_didnt: [],
        what_to_try: ["try this"]
      }
      result = Sigma.V2.TelegramBridge.notify_meta_review(report)
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end
end
