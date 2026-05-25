defmodule Darwin.V2.KillSwitchTest do
  use ExUnit.Case, async: false

  alias Darwin.V2.KillSwitch

  @feature_envs ~w(
    DARWIN_V2_ENABLED
    DARWIN_CYCLE_ENABLED
    DARWIN_SHADOW_ENABLED
    DARWIN_L5_ENABLED
    DARWIN_MCP_ENABLED
    DARWIN_ESPL_ENABLED
    DARWIN_SELF_RAG_ENABLED
    DARWIN_MAPEK_ENABLED
    DARWIN_SELF_REWARDING_ENABLED
    DARWIN_AGENTIC_RAG_ENABLED
    DARWIN_RESEARCH_REGISTRY_ENABLED
    DARWIN_TELEGRAM_ENHANCED_ENABLED
    DARWIN_AUTO_PROMOTION_ENABLED
    DARWIN_TEAM_INTEGRATION_ENABLED
    DARWIN_HYPOTHESIS_ENGINE_ENABLED
    DARWIN_MEASURE_STAGE_ENABLED
  )

  setup do
    original_env = Map.new(@feature_envs, &{&1, System.get_env(&1)})
    Enum.each(@feature_envs, &System.delete_env/1)

    on_exit(fn ->
      Enum.each(original_env, fn
        {key, nil} -> System.delete_env(key)
        {key, value} -> System.put_env(key, value)
      end)
    end)
  end

  describe "enabled?/1" do
    test "환경변수 없으면 모든 기능 비활성" do
      for feature <- [:v2, :cycle, :shadow, :l5, :mcp, :espl, :self_rag] do
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
