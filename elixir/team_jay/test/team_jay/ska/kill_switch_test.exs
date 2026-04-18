defmodule TeamJay.Ska.KillSwitchTest do
  use ExUnit.Case, async: false
  alias TeamJay.Ska.KillSwitch

  describe "Kill Switch 기본값" do
    test "skill_registry_enabled? — 기본 true" do
      System.delete_env("SKA_SKILL_REGISTRY_ENABLED")
      assert KillSwitch.skill_registry_enabled?() == true
    end

    test "mapek_enabled? — 기본 false" do
      System.delete_env("SKA_MAPEK_ENABLED")
      assert KillSwitch.mapek_enabled?() == false
    end

    test "self_rewarding_enabled? — 기본 false" do
      System.delete_env("SKA_SELF_REWARDING_ENABLED")
      assert KillSwitch.self_rewarding_enabled?() == false
    end

    test "agentic_rag_enabled? — 기본 false" do
      System.delete_env("SKA_AGENTIC_RAG_ENABLED")
      assert KillSwitch.agentic_rag_enabled?() == false
    end

    test "python_skill_enabled? — 기본 false" do
      System.delete_env("SKA_PYTHON_SKILL_ENABLED")
      assert KillSwitch.python_skill_enabled?() == false
    end

    test "naver_skill_enabled? — 기본 false" do
      System.delete_env("SKA_NAVER_SKILL_ENABLED")
      assert KillSwitch.naver_skill_enabled?() == false
    end

    test "shadow_mode_enabled? — 기본 true" do
      System.delete_env("SKA_SKILL_SHADOW_MODE")
      assert KillSwitch.shadow_mode_enabled?() == true
    end
  end

  describe "Kill Switch 활성화" do
    test "환경변수로 개별 활성화" do
      System.put_env("SKA_MAPEK_ENABLED", "true")
      assert KillSwitch.mapek_enabled?() == true
      System.put_env("SKA_MAPEK_ENABLED", "false")
    end

    test "status_all/0 — 모든 스위치 상태 맵 반환" do
      status = KillSwitch.status_all()
      assert is_map(status)
      assert Map.has_key?(status, :skill_registry)
      assert Map.has_key?(status, :mapek)
      assert Map.has_key?(status, :self_rewarding)
      assert Map.has_key?(status, :agentic_rag)
      assert Map.has_key?(status, :python_skill)
      assert Map.has_key?(status, :naver_skill)
      assert Map.has_key?(status, :shadow_mode)
    end
  end
end
