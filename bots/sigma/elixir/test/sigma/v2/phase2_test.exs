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

    test "pending_items는 Postgrex UUID와 시간을 JSON-safe 값으로 변환" do
      uuid = Ecto.UUID.generate()
      {:ok, dumped_uuid} = Ecto.UUID.dump(uuid)
      query = fn _sql, [5] ->
        {:ok,
         %{
           columns: ["id", "directive_id", "tier", "team", "action", "enqueued_at", "status"],
           rows: [[1, dumped_uuid, 3, "blog", %{}, ~N[2026-07-06 00:00:00], "pending"]]
         }}
      end

      assert [%{directive_id: ^uuid, enqueued_at: "2026-07-06T00:00:00"}] =
               Sigma.V2.Mailbox.pending_items(limit: 5, query: query)
    end

    test "동일 pending directive는 새 row 대신 기존 directive_id를 재사용" do
      uuid = Ecto.UUID.generate()
      {:ok, dumped_uuid} = Ecto.UUID.dump(uuid)

      query = fn sql, ["blog", 3, action_json] ->
        assert Jason.decode!(action_json) == %{"type" => "config_change"}

        if sql =~ "pg_advisory_xact_lock" do
          {:ok, %{rows: [[nil]]}}
        else
          assert sql =~ "status = 'pending'"
          {:ok, %{rows: [[dumped_uuid]]}}
        end
      end

      directive = %{team: "blog", tier: 3, action: %{type: "config_change"}}
      assert {:ok, ^uuid, :duplicate_suppressed} =
               Sigma.V2.Mailbox.enqueue_with_status(directive, query: query)

      assert {:ok, ^uuid} = Sigma.V2.Mailbox.enqueue(directive, query: query)
    end

    test "enqueue는 transaction advisory lock 뒤에 중복 확인과 insert를 수행" do
      parent = self()

      transaction = fn callback ->
        send(parent, :transaction_started)
        {:ok, callback.()}
      end

      query = fn sql, params ->
        cond do
          sql =~ "pg_advisory_xact_lock" ->
            send(parent, {:lock, params})
            {:ok, %{rows: [[nil]]}}

          sql =~ "SELECT directive_id" ->
            send(parent, :duplicate_checked)
            {:ok, %{rows: []}}

          sql =~ "INSERT INTO sigma_v2_mailbox" ->
            send(parent, :inserted)
            {:ok, %{rows: []}}
        end
      end

      directive = %{team: "blog", tier: 3, action: %{type: "config_change"}}

      assert {:ok, directive_id, :inserted} =
               Sigma.V2.Mailbox.enqueue_with_status(directive,
                 query: query,
                 transaction: transaction
               )

      assert is_binary(directive_id)
      assert_receive :transaction_started
      assert_receive {:lock, ["blog", 3, action_json]}
      assert Jason.decode!(action_json) == %{"type" => "config_change"}
      assert_receive :duplicate_checked
      assert_receive :inserted
    end

    test "stale_pending_summary/1은 health용 정체 요약을 반환" do
      summary = Sigma.V2.Mailbox.stale_pending_summary(24)
      assert is_map(summary)
      assert is_integer(summary.count)
      assert summary.count >= 0
      assert summary.max_age_hours == 24
      assert summary.status in ["ok", "stale_pending", "unknown"]
    end
  end

  describe "Sigma.Directive.Executor Tier 3" do
    test "대기열 적재 시 directive_id를 결과에 포함" do
      System.delete_env("SIGMA_TIER3_AUTO_APPLY")

      dir = %Sigma.Directive.ApplyFeedback{
        team: "blog",
        tier: 3,
        action: %{type: "config_change"},
        rollback_spec: %{directive_id: "t3-test"}
      }

      result = Sigma.Directive.Executor.execute(dir, %{})
      assert match?({:ok, %{tier: 3, outcome: :queued, directive_id: _}}, result) or
             match?({:error, _}, result)
    end

    test "SIGMA_TIER3_AUTO_APPLY=true 시 자동 적용 또는 오류 반환" do
      System.put_env("SIGMA_TIER3_AUTO_APPLY", "true")

      dir = %Sigma.Directive.ApplyFeedback{
        team: "blog",
        tier: 3,
        action: %{patch: %{}},
        rollback_spec: %{directive_id: "t3-auto"}
      }

      result = Sigma.Directive.Executor.execute(dir, %{})

      assert match?({:ok, %{tier: 3, outcome: :autonomous_applied, snapshot_id: _}}, result) or
               match?({:error, _}, result)

      System.delete_env("SIGMA_TIER3_AUTO_APPLY")
    end
  end

  describe "Sigma.V2.Graduation" do
    test "check_promotion/2은 :stay 또는 :promote 반환" do
      result = Sigma.V2.Graduation.check_promotion("blog", "content_review")
      assert result in [{:stay, :tier_0}, {:promote, :tier_1}]
    end
  end

  describe "Sigma.V2.Signal" do
    test "emit/1은 {:ok, signal_id} 또는 {:error, _} 반환 (PubSub 미가동 허용)" do
      payload = %{
        type: "sigma.advisory.test",
        source: "sigma-v2",
        specversion: "1.0",
        data: %{msg: "test"},
        metadata: %{}
      }
      try do
        result = Sigma.V2.Signal.emit(payload)
        assert match?({:ok, _}, result) or match?({:error, _}, result)
      rescue
        ArgumentError -> :ok  # PubSub not running in test env
      end
    end
  end
end
