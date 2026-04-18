defmodule Darwin.V2.MapeKLoopTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.MapeKLoop

  describe "init/1 — dormant mode (kill switch OFF)" do
    test "DARWIN_MAPEK_ENABLED 없으면 dormant: true로 초기화" do
      System.delete_env("DARWIN_V2_ENABLED")
      System.delete_env("DARWIN_MAPEK_ENABLED")

      {:ok, state} = MapeKLoop.init([])
      assert state.dormant == true
      assert state.total_cycles == 0
    end

    test "DARWIN_V2_ENABLED=false 이면 dormant 상태" do
      System.put_env("DARWIN_V2_ENABLED", "false")
      System.delete_env("DARWIN_MAPEK_ENABLED")
      on_exit(fn -> System.delete_env("DARWIN_V2_ENABLED") end)

      {:ok, state} = MapeKLoop.init([])
      assert state.dormant == true
    end
  end

  describe "handle_cast/2 — cycle_complete 이벤트" do
    test "cycle_complete 수신 시 total_cycles 증가" do
      state = %{
        total_cycles: 3,
        last_cycle_at: nil,
        last_cycle_id: nil,
        last_monitor_at: nil,
        last_weekly_knowledge_at: nil,
        dormant: false,
        started_at: DateTime.utc_now()
      }

      cycle_result = %{cycle_id: "test-cycle-001", successes: 2, failures: 0}

      {:noreply, new_state} = MapeKLoop.handle_cast({:cycle_complete, cycle_result}, state)

      assert new_state.total_cycles == 4
      assert new_state.last_cycle_id == "test-cycle-001"
      assert new_state.last_cycle_at != nil
    end

    test "cycle_complete 수신 시 last_cycle_at 갱신" do
      state = %{
        total_cycles: 0,
        last_cycle_at: nil,
        last_cycle_id: nil,
        last_monitor_at: nil,
        last_weekly_knowledge_at: nil,
        dormant: false,
        started_at: DateTime.utc_now()
      }

      {:noreply, new_state} = MapeKLoop.handle_cast({:cycle_complete, %{cycle_id: "x"}}, state)
      assert %DateTime{} = new_state.last_cycle_at
    end
  end

  describe "handle_call/3 — status" do
    test "status 호출 시 현재 상태 반환" do
      state = %{
        total_cycles: 5,
        last_cycle_at: nil,
        last_cycle_id: "abc",
        last_monitor_at: nil,
        last_weekly_knowledge_at: nil,
        dormant: false,
        started_at: DateTime.utc_now()
      }

      {:reply, reply, ^state} = MapeKLoop.handle_call(:status, self(), state)
      assert reply.total_cycles == 5
      assert reply.last_cycle_id == "abc"
    end
  end

  describe "handle_cast/2 — weekly_knowledge" do
    test "weekly_knowledge 수신 시 last_weekly_knowledge_at 갱신" do
      state = %{
        total_cycles: 0,
        last_cycle_at: nil,
        last_cycle_id: nil,
        last_monitor_at: nil,
        last_weekly_knowledge_at: nil,
        dormant: false,
        started_at: DateTime.utc_now()
      }

      {:noreply, new_state} = MapeKLoop.handle_cast(:weekly_knowledge, state)
      assert %DateTime{} = new_state.last_weekly_knowledge_at
    end
  end

  describe "Darwin.V2.KillSwitch — Phase R 신규 키" do
    test "DARWIN_MAPEK_ENABLED 키 정상 동작" do
      System.delete_env("DARWIN_MAPEK_ENABLED")
      refute Darwin.V2.KillSwitch.enabled?(:mapek)

      System.put_env("DARWIN_MAPEK_ENABLED", "true")
      on_exit(fn -> System.delete_env("DARWIN_MAPEK_ENABLED") end)
      assert Darwin.V2.KillSwitch.enabled?(:mapek)
    end

    test "DARWIN_SELF_REWARDING_ENABLED 키 정상 동작" do
      System.delete_env("DARWIN_SELF_REWARDING_ENABLED")
      refute Darwin.V2.KillSwitch.enabled?(:self_rewarding)
    end

    test "DARWIN_AGENTIC_RAG_ENABLED 키 정상 동작" do
      System.delete_env("DARWIN_AGENTIC_RAG_ENABLED")
      refute Darwin.V2.KillSwitch.enabled?(:agentic_rag)
    end

    test "DARWIN_RESEARCH_REGISTRY_ENABLED 키 정상 동작" do
      System.delete_env("DARWIN_RESEARCH_REGISTRY_ENABLED")
      refute Darwin.V2.KillSwitch.enabled?(:research_registry)
    end

    test "DARWIN_TELEGRAM_ENHANCED_ENABLED 키 정상 동작" do
      System.delete_env("DARWIN_TELEGRAM_ENHANCED_ENABLED")
      refute Darwin.V2.KillSwitch.enabled?(:telegram_enhanced)
    end
  end

  describe "Darwin.V2.Topics — MAPE-K 토픽" do
    test "cycle_complete 토픽 문자열 반환" do
      assert Darwin.V2.Topics.cycle_complete() == "darwin.mapek.cycle.complete"
    end

    test "cycle_knowledge_complete 토픽 문자열 반환" do
      assert Darwin.V2.Topics.cycle_knowledge_complete() == "darwin.mapek.cycle.knowledge_complete"
    end

    test "promotion_eligibility 토픽 문자열 반환" do
      assert Darwin.V2.Topics.promotion_eligibility() == "darwin.mapek.promotion.eligibility"
    end
  end

  describe "Darwin.V2.SelfRewarding — 스텁 동작 확인" do
    test "evaluate_cycle/1 호출 시 :ok 반환" do
      assert :ok == Darwin.V2.SelfRewarding.evaluate_cycle("test-cycle")
    end

    test "evaluate_week/0 호출 시 :ok 반환" do
      assert :ok == Darwin.V2.SelfRewarding.evaluate_week()
    end
  end

  describe "Darwin.V2.ResearchRegistry — 스텁 동작 확인" do
    test "record_cycle_result/1 호출 시 :ok 반환" do
      assert :ok == Darwin.V2.ResearchRegistry.record_cycle_result(%{cycle_id: "x"})
    end

    test "refresh_effects/0 호출 시 :ok 반환" do
      assert :ok == Darwin.V2.ResearchRegistry.refresh_effects()
    end
  end
end
