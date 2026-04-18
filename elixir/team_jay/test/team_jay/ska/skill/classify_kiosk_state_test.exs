defmodule TeamJay.Ska.Skill.ClassifyKioskStateTest do
  use ExUnit.Case, async: true

  alias TeamJay.Ska.Skill.ClassifyKioskState

  describe "run/2" do
    test "heartbeat 60초 초과 → :offline" do
      assert {:ok, %{state: :offline, reason: "heartbeat_timeout_60s"}} =
               ClassifyKioskState.run(%{
                 response: %{status: "idle"},
                 last_heartbeat_ms: 65_000
               }, %{})
    end

    test "SYSTEM_FROZEN 에러 코드 → :frozen" do
      assert {:ok, %{state: :frozen, reason: "explicit_frozen_error_code"}} =
               ClassifyKioskState.run(%{
                 response: %{error_code: "SYSTEM_FROZEN"},
                 last_heartbeat_ms: 1_000
               }, %{})
    end

    test "processing_order → :active" do
      assert {:ok, %{state: :active, reason: "order_in_progress"}} =
               ClassifyKioskState.run(%{
                 response: %{status: "processing_order"},
                 last_heartbeat_ms: 1_000
               }, %{})
    end

    test "payment_pending → :payment_wait" do
      assert {:ok, %{state: :payment_wait, reason: "awaiting_payment"}} =
               ClassifyKioskState.run(%{
                 response: %{status: "payment_pending"},
                 last_heartbeat_ms: 1_000
               }, %{})
    end

    test "idle → :idle" do
      assert {:ok, %{state: :idle, reason: "no_active_session"}} =
               ClassifyKioskState.run(%{
                 response: %{status: "idle"},
                 last_heartbeat_ms: 1_000
               }, %{})
    end

    test "알 수 없는 상태 → :unknown confidence 0.3" do
      assert {:ok, %{state: :unknown, confidence: 0.3}} =
               ClassifyKioskState.run(%{
                 response: %{status: "some_other_status"},
                 last_heartbeat_ms: 1_000
               }, %{})
    end

    test "정상 상태 confidence 0.95" do
      assert {:ok, %{confidence: 0.95}} =
               ClassifyKioskState.run(%{
                 response: %{status: "idle"},
                 last_heartbeat_ms: 1_000
               }, %{})
    end
  end

  describe "metadata/0" do
    test "도메인 :kiosk" do
      assert ClassifyKioskState.metadata().domain == :kiosk
    end
  end
end
