defmodule Darwin.V2.KillSwitchTest do
  use ExUnit.Case

  test "enabled?/1 환경변수 없으면 false" do
    System.delete_env("DARWIN_V2_ENABLED")
    refute Darwin.V2.KillSwitch.enabled?(:v2)
  end

  test "enabled?/1 환경변수 true이면 true" do
    System.put_env("DARWIN_V2_ENABLED", "true")
    assert Darwin.V2.KillSwitch.enabled?(:v2)
    System.delete_env("DARWIN_V2_ENABLED")
  end
end
