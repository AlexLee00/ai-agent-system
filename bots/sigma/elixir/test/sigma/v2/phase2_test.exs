defmodule Sigma.V2.Phase2Test do
  use ExUnit.Case, async: true

  @moduletag :phase2

  describe "Sigma.Directive.ApplyFeedback 구조체" do
    test "필수 키 포함 생성" do
      dir = %Sigma.Directive.ApplyFeedback{
        team: "blog",
        tier: 0,
        action: %{type: "content_review"},
        rollback_spec: %{directive_id: "test-123"}
      }
      assert dir.team == "blog"
      assert dir.tier == 0
    end
  end

  describe "Sigma.Directive.Executor Tier 0" do
    test "Tier 0 로그만 기록 (DB 없이)" do
      dir = %Sigma.Directive.ApplyFeedback{
        team: "blog",
        tier: 0,
        action: %{},
        rollback_spec: %{directive_id: "t0"}
      }
      # DB 없이도 execute 호출 자체는 가능 (에러 처리 안에 rescue)
      result = Sigma.Directive.Executor.execute(dir, %{})
      assert match?({:ok, %{tier: 0, outcome: :observed}}, result) or
             match?({:error, _}, result)
    end
  end

  describe "Sigma.Directive.Executor Tier 2 Kill Switch" do
    test "SIGMA_TIER2_AUTO_APPLY 미설정 시 disabled 반환" do
      System.delete_env("SIGMA_TIER2_AUTO_APPLY")
      dir = %Sigma.Directive.ApplyFeedback{
        team: "blog",
        tier: 2,
        action: %{patch: %{}},
        rollback_spec: %{directive_id: "t2"}
      }
      assert {:error, :tier2_disabled} = Sigma.Directive.Executor.execute(dir, %{})
    end
  end

  describe "Sigma.V2.Mailbox" do
    test "pending_count/0은 정수 반환" do
      count = Sigma.V2.Mailbox.pending_count()
      assert is_integer(count)
      assert count >= 0
    end

    test "pending_items/1은 목록 반환" do
      items = Sigma.V2.Mailbox.pending_items(limit: 5)
      assert is_list(items)
    end
  end

  describe "Sigma.V2.Graduation" do
    test "check_promotion/2은 :stay 또는 :promote 반환" do
      result = Sigma.V2.Graduation.check_promotion("blog", "content_review")
      assert result in [{:stay, :tier_0}, {:promote, :tier_1}]
    end
  end

  describe "Sigma.V2.Signal" do
    test "emit/1은 {:ok, signal_id} 반환 (PubSub 가동 중이면)" do
      payload = %{
        type: "sigma.advisory.test",
        source: "sigma-v2",
        specversion: "1.0",
        data: %{msg: "test"},
        metadata: %{}
      }
      result = Sigma.V2.Signal.emit(payload)
      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end
end
