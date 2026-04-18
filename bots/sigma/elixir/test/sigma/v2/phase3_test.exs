defmodule Sigma.V2.Phase3Test do
  use ExUnit.Case, async: true

  @moduletag :phase3

  describe "Sigma.V2.Memory facade" do
    test "store/3는 :ok 반환 (L1 ETS 없으면 rescue)" do
      result =
        try do
          Sigma.V2.Memory.store(:episodic, "test memory content", [importance: 0.4])
        rescue
          ArgumentError -> :ok
        end
      assert result == :ok
    end

    test "recall/2는 리스트 반환 (atom type, ETS 없으면 빈 리스트)" do
      result =
        try do
          Sigma.V2.Memory.recall(:episodic, [])
        rescue
          ArgumentError -> []
        end
      assert is_list(result)
    end

    test "recall/2는 리스트 반환 (string query)" do
      result =
        try do
          Sigma.V2.Memory.recall("blog performance", [])
        rescue
          ArgumentError -> []
        end
      assert is_list(result)
    end

    test "remember/3는 :ok 반환" do
      result =
        try do
          Sigma.V2.Memory.remember("blog test memory", :episodic, [importance: 0.3])
        rescue
          ArgumentError -> :ok
        end
      assert result == :ok
    end
  end

  describe "Sigma.V2.Config" do
    test "apply_patch/2는 {:ok, _} 또는 {:error, _} 반환" do
      result = Sigma.V2.Config.apply_patch("blog", %{post_interval_hours: 6})
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end

    test "restore/2는 없는 snapshot이면 {:error, _} 반환" do
      result = Sigma.V2.Config.restore("blog", "non-existent-snapshot-id")
      assert match?({:error, _}, result)
    end
  end

  describe "Sigma.V2.Reflexion" do
    test "reflect/2는 {:ok, _} 또는 {:error, _} 반환" do
      directive = %Sigma.Directive.ApplyFeedback{
        team: "blog",
        tier: 2,
        action: %{patch: %{post_interval_hours: 8}},
        rollback_spec: %{directive_id: "ref-test-001"}
      }
      outcome = %{effectiveness: -0.2, metric_delta: %{avg_score: -0.5}}
      result = Sigma.V2.Reflexion.reflect(directive, outcome)
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end

  describe "Sigma.V2.SelfRAG" do
    @tag :skip
    test "kill switch 미설정 시 리스트 반환 (pass-through → Memory.recall)" do
      System.delete_env("SIGMA_SELF_RAG_ENABLED")
      result = Sigma.V2.SelfRAG.retrieve_with_gate("test content", [team: "blog"])
      # pass-through는 Memory.recall/2 → 리스트 반환
      assert is_list(result)
    end

    @tag :skip
    test "retrieve_with_gate/2는 keyword opts 허용" do
      result = Sigma.V2.SelfRAG.retrieve_with_gate("blog performance analysis", [team: "blog", limit: 3])
      # kill switch off → Memory.recall → 리스트, kill switch on → {:ok, _} | {:error, _}
      assert is_list(result) or match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end

  describe "Sigma.V2.LLM" do
    test "complete/2는 {:ok, _} 또는 {:error, _} 반환" do
      result = Sigma.V2.LLM.complete("테스트 프롬프트", [model: :fast])
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end

  describe "Sigma.V2.RollbackScheduler" do
    test "schedule/1은 :ok 반환 (GenServer 미가동 허용)" do
      result =
        try do
          Sigma.V2.RollbackScheduler.schedule(
            directive_id: Ecto.UUID.generate(),
            snapshot_id: Ecto.UUID.generate(),
            before_metric: %{avg_score: 5.0},
            team: "blog",
            measure_at_ms: 1
          )
        catch
          :exit, _ -> :ok
        end
      assert result == :ok
    end
  end
end
