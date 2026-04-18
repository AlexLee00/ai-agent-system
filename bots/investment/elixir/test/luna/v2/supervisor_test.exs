defmodule Luna.V2.SupervisorTest do
  use ExUnit.Case, async: false

  test "KillSwitch 기본값 — v2_enabled false" do
    Application.put_env(:luna, :v2_enabled, false)
    refute Luna.V2.KillSwitch.v2_enabled?()
    Application.put_env(:luna, :v2_enabled, false)
  end

  test "KillSwitch commander_enabled false by default" do
    Application.put_env(:luna, :commander_enabled, false)
    refute Luna.V2.KillSwitch.commander_enabled?()
  end

  test "kill switch mapek_enabled false by default" do
    Application.put_env(:luna, :mapek_enabled, false)
    refute Luna.V2.KillSwitch.mapek_enabled?()
  end
end
