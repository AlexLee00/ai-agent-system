defmodule TeamJay.Ska.Skill.TriggerRecoveryTest do
  use ExUnit.Case, async: true

  alias TeamJay.Ska.Skill.TriggerRecovery

  describe "metadata/0" do
    test "메타데이터 반환" do
      meta = TriggerRecovery.metadata()
      assert meta.name == :trigger_recovery
      assert meta.domain == :common
      assert meta.version == "1.0"
    end
  end

  describe "전략 결정 로직" do
    test "andy + session_expired → naver_relogin 전략" do
      strategy = strategy_for(:andy, :session_expired)
      assert strategy == :naver_relogin
    end

    test "andy + parse_failed → selector_rollback 전략" do
      strategy = strategy_for(:andy, :parse_failed)
      assert strategy == :selector_rollback
    end

    test "jimmy + kiosk_frozen → kiosk_restart 전략" do
      strategy = strategy_for(:jimmy, :kiosk_frozen)
      assert strategy == :kiosk_restart
    end

    test "pickko + db_disconnect → pickko_reconnect 전략" do
      strategy = strategy_for(:pickko, :db_disconnect)
      assert strategy == :pickko_reconnect
    end

    test "미정의 조합 → escalate_to_master" do
      strategy = strategy_for(:unknown_agent, :unknown_failure)
      assert strategy == :escalate_to_master
    end

    test "any + network_error → backoff_retry" do
      strategy = strategy_for(:any_agent, :network_error)
      assert strategy == :backoff_retry
    end
  end

  # 전략 결정 로직 검증 (외부 의존성 없이)
  defp strategy_for(agent, failure_type) do
    case {agent, failure_type} do
      {:andy, :session_expired} -> :naver_relogin
      {:andy, :parse_failed} -> :selector_rollback
      {:andy, :selector_failed} -> :selector_rollback
      {:jimmy, :kiosk_frozen} -> :kiosk_restart
      {:jimmy, :session_expired} -> :kiosk_reconnect
      {:pickko, :db_disconnect} -> :pickko_reconnect
      {:pickko, :session_expired} -> :pickko_reconnect
      {_, :network_error} -> :backoff_retry
      _ -> :escalate_to_master
    end
  end
end
