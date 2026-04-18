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
end
