defmodule Luna.V2.TelegramReporterTest do
  use ExUnit.Case, async: true

  alias Luna.V2.TelegramReporter

  setup_all do
    Code.ensure_compiled!(TelegramReporter)
    :ok
  end

  describe "모듈 구조" do
    test "TelegramReporter 컴파일됨" do
      assert Code.ensure_loaded?(TelegramReporter)
    end

    test "send/2 존재" do
      assert function_exported?(TelegramReporter, :send, 2)
    end

    test "daily_summary/1 존재" do
      assert function_exported?(TelegramReporter, :daily_summary, 1)
    end

    test "weekly_summary/1 존재" do
      assert function_exported?(TelegramReporter, :weekly_summary, 1)
    end

    test "channels/0 존재" do
      assert function_exported?(TelegramReporter, :channels, 0)
    end
  end

  describe "채널 매핑" do
    test "5개 채널 정의됨" do
      channels = TelegramReporter.channels()
      assert length(channels) == 5
    end

    test "general 채널 존재" do
      assert :general in TelegramReporter.channels()
    end

    test "luna_crypto 채널 존재" do
      assert :luna_crypto in TelegramReporter.channels()
    end

    test "luna_domestic 채널 존재" do
      assert :luna_domestic in TelegramReporter.channels()
    end

    test "luna_overseas 채널 존재" do
      assert :luna_overseas in TelegramReporter.channels()
    end

    test "luna_risk 채널 존재" do
      assert :luna_risk in TelegramReporter.channels()
    end

    test "잘못된 채널 → 오류 반환 (예외 없음)" do
      result = TelegramReporter.send(:invalid_channel, "test")
      assert result == {:error, :unknown_channel}
    end
  end
end
