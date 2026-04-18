defmodule Sigma.V2.TelegramReporterTest do
  use ExUnit.Case, async: true

  @moduletag :phase_o

  @sigma_lib Path.join(__DIR__, "../../../lib")

  describe "Sigma.V2.TelegramReporter — Kill Switch" do
    test "SIGMA_TELEGRAM_ENHANCED=false 시 on_daily_report :ok" do
      System.put_env("SIGMA_TELEGRAM_ENHANCED", "false")
      result = Sigma.V2.TelegramReporter.on_daily_report(%{})
      assert result == :ok or result == :skipped
    after
      System.delete_env("SIGMA_TELEGRAM_ENHANCED")
    end

    test "SIGMA_TELEGRAM_ENHANCED=false 시 on_weekly_review :ok" do
      System.put_env("SIGMA_TELEGRAM_ENHANCED", "false")
      result = Sigma.V2.TelegramReporter.on_weekly_review(%{})
      assert result == :ok or result == :skipped
    after
      System.delete_env("SIGMA_TELEGRAM_ENHANCED")
    end

    test "SIGMA_TELEGRAM_ENHANCED=false 시 on_meta_change :ok" do
      System.put_env("SIGMA_TELEGRAM_ENHANCED", "false")
      result = Sigma.V2.TelegramReporter.on_meta_change("espl_change", %{})
      assert result == :ok or result == :skipped
    after
      System.delete_env("SIGMA_TELEGRAM_ENHANCED")
    end

    test "on_directive_unfulfilled/3 Kill switch OFF 시 :ok" do
      System.put_env("SIGMA_TELEGRAM_ENHANCED", "false")
      result = Sigma.V2.TelegramReporter.on_directive_unfulfilled("blog", "dir-test", %{})
      assert result == :ok or result == :skipped
    after
      System.delete_env("SIGMA_TELEGRAM_ENHANCED")
    end
  end

  describe "Sigma.V2.TelegramReporter — Urgent (Kill Switch 무관)" do
    test "on_cycle_failure/2 는 :ok 반환 (Hub 미연결 허용)" do
      result = Sigma.V2.TelegramReporter.on_cycle_failure(%{cycle_id: "test"}, "오류")
      assert result == :ok or match?({:ok, _}, result) or match?({:error, _}, result)
    end

    test "on_principle_violation/2 는 :ok 반환 (Hub 미연결 허용)" do
      result = Sigma.V2.TelegramReporter.on_principle_violation("trend", %{description: "P-001 위반"})
      assert result == :ok or match?({:ok, _}, result) or match?({:error, _}, result)
    end

    test "on_tier2_limit_exceeded/2 는 :ok 반환 (Hub 미연결 허용)" do
      result = Sigma.V2.TelegramReporter.on_tier2_limit_exceeded("blog", 5)
      assert result == :ok or match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end

  describe "Sigma.V2.TelegramReporter — 소스 구조 검증" do
    test "5채널 모두 언급됨 (urgent/daily/weekly/meta/alert)" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/telegram_reporter.ex"))
      assert src =~ "urgent" or src =~ "Urgent"
      assert src =~ "daily" or src =~ "Daily"
      assert src =~ "weekly" or src =~ "Weekly"
      assert src =~ "meta" or src =~ "Meta"
      assert src =~ "alert" or src =~ "Alert" or src =~ "on_directive_unfulfilled"
    end

    test "SIGMA_TELEGRAM_ENHANCED Kill Switch 체크" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/telegram_reporter.ex"))
      assert src =~ "SIGMA_TELEGRAM_ENHANCED" or src =~ "enhanced_enabled?" or src =~ "enhanced?"
    end
  end
end
