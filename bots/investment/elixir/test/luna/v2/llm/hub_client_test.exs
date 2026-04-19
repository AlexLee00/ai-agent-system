defmodule Luna.V2.LLM.HubClientTest do
  use ExUnit.Case, async: true

  alias Luna.V2.LLM.HubClient

  setup do
    old_routing = System.get_env("LUNA_LLM_HUB_ROUTING_ENABLED")
    old_shadow  = System.get_env("LUNA_LLM_HUB_ROUTING_SHADOW")

    on_exit(fn ->
      if old_routing, do: System.put_env("LUNA_LLM_HUB_ROUTING_ENABLED", old_routing),
                      else: System.delete_env("LUNA_LLM_HUB_ROUTING_ENABLED")
      if old_shadow,  do: System.put_env("LUNA_LLM_HUB_ROUTING_SHADOW", old_shadow),
                      else: System.delete_env("LUNA_LLM_HUB_ROUTING_SHADOW")
    end)

    :ok
  end

  describe "enabled?/0" do
    test "기본값 false (환경변수 미설정)" do
      System.delete_env("LUNA_LLM_HUB_ROUTING_ENABLED")
      refute HubClient.enabled?()
    end

    test "'true' 설정 시 true" do
      System.put_env("LUNA_LLM_HUB_ROUTING_ENABLED", "true")
      assert HubClient.enabled?()
    end

    test "'false' 설정 시 false" do
      System.put_env("LUNA_LLM_HUB_ROUTING_ENABLED", "false")
      refute HubClient.enabled?()
    end
  end

  describe "shadow?/0" do
    test "기본값 false" do
      System.delete_env("LUNA_LLM_HUB_ROUTING_SHADOW")
      refute HubClient.shadow?()
    end

    test "'true' 설정 시 true" do
      System.put_env("LUNA_LLM_HUB_ROUTING_SHADOW", "true")
      assert HubClient.shadow?()
    end
  end

  describe "call/1" do
    test "잘못된 Hub URL → {:error, _}" do
      System.put_env("LUNA_LLM_HUB_ROUTING_ENABLED", "true")
      System.put_env("HUB_BASE_URL", "http://localhost:19998")

      result = HubClient.call(%{
        prompt: "루나 테스트 프롬프트",
        abstract_model: :anthropic_haiku,
        agent: "luna.test"
      })

      assert match?({:error, _}, result)
    after
      System.delete_env("HUB_BASE_URL")
    end

    test "Hub 연결 결과 구조 — ok 또는 error" do
      System.put_env("LUNA_LLM_HUB_ROUTING_ENABLED", "true")

      result = HubClient.call(%{
        prompt: "ping",
        abstract_model: :anthropic_haiku,
        agent: "luna.test"
      })

      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end
  end

  describe "공개 API 확인" do
    test "enabled?/0 함수 존재" do
      assert function_exported?(HubClient, :enabled?, 0)
    end

    test "shadow?/0 함수 존재" do
      assert function_exported?(HubClient, :shadow?, 0)
    end

    test "call/1 함수 존재" do
      assert function_exported?(HubClient, :call, 1)
    end
  end

  describe "팀 설정 확인" do
    test "Luna 팀 환경변수 이름 — LUNA_LLM_HUB_ROUTING_ENABLED" do
      System.delete_env("LUNA_LLM_HUB_ROUTING_ENABLED")
      refute HubClient.enabled?()
      System.put_env("LUNA_LLM_HUB_ROUTING_ENABLED", "true")
      assert HubClient.enabled?()
    end

    test "Shadow 환경변수 이름 — LUNA_LLM_HUB_ROUTING_SHADOW" do
      System.delete_env("LUNA_LLM_HUB_ROUTING_SHADOW")
      refute HubClient.shadow?()
      System.put_env("LUNA_LLM_HUB_ROUTING_SHADOW", "true")
      assert HubClient.shadow?()
    end
  end
end
