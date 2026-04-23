defmodule Luna.V2.KillSwitchTest do
  use ExUnit.Case, async: true

  test "기본값 ALL OFF" do
    Application.put_env(:luna, :v2_enabled, false)
    Application.put_env(:luna, :commander_enabled, false)
    Application.put_env(:luna, :mapek_enabled, false)

    refute Luna.V2.KillSwitch.v2_enabled?()
    refute Luna.V2.KillSwitch.commander_enabled?()
    refute Luna.V2.KillSwitch.mapek_enabled?()
  end

  test "v2_enabled true" do
    Application.put_env(:luna, :v2_enabled, true)
    assert Luna.V2.KillSwitch.v2_enabled?()
    Application.put_env(:luna, :v2_enabled, false)
  end

  test "position watch defaults are readable" do
    Application.put_env(:luna, :position_watch_enabled, true)
    Application.put_env(:luna, :position_watch_interval_ms, 60_000)
    Application.put_env(:luna, :position_watch_crypto_realtime_ms, 15_000)
    Application.put_env(:luna, :position_watch_stock_realtime_ms, 15_000)
    Application.put_env(:luna, :position_watch_stock_offhours_ms, 300_000)

    assert Luna.V2.KillSwitch.position_watch_enabled?()
    assert Luna.V2.KillSwitch.position_watch_interval_ms() == 60_000
    assert Luna.V2.KillSwitch.position_watch_crypto_realtime_ms() == 15_000
    assert Luna.V2.KillSwitch.position_watch_stock_realtime_ms() == 15_000
    assert Luna.V2.KillSwitch.position_watch_stock_offhours_ms() == 300_000
  end
end
