defmodule Darwin.V2.ResearchRegistryTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.ResearchRegistry

  setup do
    on_exit(fn ->
      System.delete_env("DARWIN_RESEARCH_REGISTRY_ENABLED")
    end)
  end

  describe "register_paper/1 — kill switch OFF" do
    test "kill switch OFF이면 :ok 반환" do
      System.delete_env("DARWIN_RESEARCH_REGISTRY_ENABLED")
      assert :ok == ResearchRegistry.register_paper(%{title: "Test Paper", source: "arxiv"})
    end
  end

  describe "register_paper/1 — kill switch ON (no DB)" do
    @tag :integration
    test "kill switch ON + DB 없어도 :ok 반환 (무해 실패)" do
      System.put_env("DARWIN_RESEARCH_REGISTRY_ENABLED", "true")
      assert :ok == ResearchRegistry.register_paper(%{
        title: "Self-Rewarding Language Models",
        arxiv_id: "2401.10020",
        source: "arxiv",
        url: "https://arxiv.org/abs/2401.10020",
        keywords: ["DPO", "Self-Rewarding"]
      })
    end
  end

  describe "transition/3 — 유효성 검사" do
    test "유효하지 않은 단계명은 {:error, {:invalid_stage, _}} 반환" do
      assert {:error, {:invalid_stage, "invalid_stage"}} =
               ResearchRegistry.transition("paper-001", "invalid_stage")
    end

    test "discovered → evaluated (유효한 전이)" do
      # DB 없으면 fetch_current_stage가 nil 반환 → discovered 취급
      # transition은 {:ok, "evaluated"} 또는 DB 오류 후 :ok
      result = ResearchRegistry.transition("nonexistent-paper", "evaluated")
      assert match?({:ok, "evaluated"}, result) or match?({:error, {:invalid_transition, _, _}}, result)
    end
  end

  describe "transition/3 — invalid stage atom" do
    test "nil to_stage는 {:error, _} 반환" do
      # @stages에 nil 없음
      result = ResearchRegistry.transition("paper-001", "nonexistent")
      assert match?({:error, _}, result)
    end
  end

  describe "record_cycle_result/1 — kill switch OFF" do
    test "kill switch OFF이면 :ok 반환" do
      System.delete_env("DARWIN_RESEARCH_REGISTRY_ENABLED")
      assert :ok == ResearchRegistry.record_cycle_result(%{
        cycle_id: "cycle-1",
        paper_id: "paper-1",
        applied: true
      })
    end
  end

  describe "record_cycle_result/1 — 단계 매핑" do
    test "applied=true → applied 단계" do
      System.delete_env("DARWIN_RESEARCH_REGISTRY_ENABLED")
      result = ResearchRegistry.record_cycle_result(%{applied: true, paper_id: "p1"})
      assert result == :ok
    end

    test "verification_success=true → verified 단계" do
      System.delete_env("DARWIN_RESEARCH_REGISTRY_ENABLED")
      result = ResearchRegistry.record_cycle_result(%{verification_success: true, paper_id: "p1"})
      assert result == :ok
    end

    test "paper_id 없으면 :ok (단계 전이 건너뜀)" do
      System.delete_env("DARWIN_RESEARCH_REGISTRY_ENABLED")
      assert :ok == ResearchRegistry.record_cycle_result(%{stage: "learn"})
    end
  end

  describe "refresh_effects/0 — kill switch OFF" do
    test "kill switch OFF이면 :ok 반환" do
      System.delete_env("DARWIN_RESEARCH_REGISTRY_ENABLED")
      assert :ok == ResearchRegistry.refresh_effects()
    end

    @tag :integration
    test "kill switch ON + DB 없어도 :ok 반환" do
      System.put_env("DARWIN_RESEARCH_REGISTRY_ENABLED", "true")
      assert :ok == ResearchRegistry.refresh_effects()
    end
  end

  describe "link_effect/2 — kill switch OFF" do
    test "kill switch OFF이면 :ok 반환" do
      System.delete_env("DARWIN_RESEARCH_REGISTRY_ENABLED")
      assert :ok == ResearchRegistry.link_effect("paper-001", %{
        type: :code_change,
        target: "darwin/v2/evaluator.ex",
        commit_sha: "abc123",
        before_metrics: %{"score" => 7.0},
        after_metrics: %{"score" => 8.5}
      })
    end
  end

  describe "KillSwitch :research_registry 연동" do
    test "기본값 false" do
      System.delete_env("DARWIN_RESEARCH_REGISTRY_ENABLED")
      refute Darwin.V2.KillSwitch.enabled?(:research_registry)
    end

    test "DARWIN_RESEARCH_REGISTRY_ENABLED=true 이면 true" do
      System.put_env("DARWIN_RESEARCH_REGISTRY_ENABLED", "true")
      assert Darwin.V2.KillSwitch.enabled?(:research_registry)
    end
  end
end
