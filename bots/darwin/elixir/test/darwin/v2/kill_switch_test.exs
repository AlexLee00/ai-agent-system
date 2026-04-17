defmodule Darwin.V2.KillSwitchTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.KillSwitch

  describe "enabled?/1" do
    test "환경변수 없으면 모든 기능 비활성" do
      for feature <- [:v2, :cycle, :shadow, :l5, :mcp, :espl, :self_rag] do
        env_key = "DARWIN_#{String.upcase(to_string(feature))}_ENABLED"
        System.delete_env(env_key)
        refute KillSwitch.enabled?(feature), "#{feature}가 비활성이어야 함"
      end
    end

    test "DARWIN_V2_ENABLED=true → :v2 활성" do
      System.put_env("DARWIN_V2_ENABLED", "true")
      on_exit(fn -> System.delete_env("DARWIN_V2_ENABLED") end)
      assert KillSwitch.enabled?(:v2)
    end

    test "DARWIN_V2_ENABLED=false → :v2 비활성" do
      System.put_env("DARWIN_V2_ENABLED", "false")
      on_exit(fn -> System.delete_env("DARWIN_V2_ENABLED") end)
      refute KillSwitch.enabled?(:v2)
    end
  end

  describe "active_features/0" do
    test "환경변수 없으면 빈 목록" do
      for f <- [:v2, :cycle, :shadow, :l5, :mcp, :espl, :self_rag] do
        System.delete_env("DARWIN_#{String.upcase(to_string(f))}_ENABLED")
      end
      assert KillSwitch.active_features() == []
    end

    test "v2 + espl 활성화 시 목록에 포함" do
      System.put_env("DARWIN_V2_ENABLED", "true")
      System.put_env("DARWIN_ESPL_ENABLED", "true")
      on_exit(fn ->
        System.delete_env("DARWIN_V2_ENABLED")
        System.delete_env("DARWIN_ESPL_ENABLED")
      end)
      active = KillSwitch.active_features()
      assert :v2 in active
      assert :espl in active
    end
  end
end
