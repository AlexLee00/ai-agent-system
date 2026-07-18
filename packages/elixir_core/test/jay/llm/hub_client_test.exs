defmodule Jay.Core.LLM.HubClientTest do
  use ExUnit.Case, async: true

  defmodule TestHubClient do
    use Jay.Core.LLM.HubClient,
      team: "test_team",
      routing_env: "TEST_LLM_HUB_ROUTING_ENABLED",
      shadow_env: "TEST_LLM_HUB_ROUTING_SHADOW"
  end

  setup do
    old_routing = System.get_env("TEST_LLM_HUB_ROUTING_ENABLED")
    old_shadow = System.get_env("TEST_LLM_HUB_ROUTING_SHADOW")

    on_exit(fn ->
      if old_routing,
        do: System.put_env("TEST_LLM_HUB_ROUTING_ENABLED", old_routing),
        else: System.delete_env("TEST_LLM_HUB_ROUTING_ENABLED")

      if old_shadow,
        do: System.put_env("TEST_LLM_HUB_ROUTING_SHADOW", old_shadow),
        else: System.delete_env("TEST_LLM_HUB_ROUTING_SHADOW")
    end)

    :ok
  end

  describe "enabled?/0" do
    test "환경변수 unset → false" do
      System.delete_env("TEST_LLM_HUB_ROUTING_ENABLED")
      refute TestHubClient.enabled?()
    end

    test "환경변수 'true' → true" do
      System.put_env("TEST_LLM_HUB_ROUTING_ENABLED", "true")
      assert TestHubClient.enabled?()
    end

    test "환경변수 'false' → false" do
      System.put_env("TEST_LLM_HUB_ROUTING_ENABLED", "false")
      refute TestHubClient.enabled?()
    end
  end

  describe "shadow?/0" do
    test "환경변수 unset → false" do
      System.delete_env("TEST_LLM_HUB_ROUTING_SHADOW")
      refute TestHubClient.shadow?()
    end

    test "환경변수 'true' → true" do
      System.put_env("TEST_LLM_HUB_ROUTING_SHADOW", "true")
      assert TestHubClient.shadow?()
    end
  end

  describe "call/1 — 연결 결과" do
    test "Hub 연결 시 {:ok, _} 또는 {:error, _} 반환" do
      System.put_env("TEST_LLM_HUB_ROUTING_ENABLED", "true")

      result =
        TestHubClient.call(%{
          prompt: "ping",
          abstract_model: :anthropic_haiku,
          agent: "test_agent"
        })

      assert match?({:ok, _}, result) or match?({:error, _}, result)
    end

    test "잘못된 Hub URL → {:error, _}" do
      System.put_env("TEST_LLM_HUB_ROUTING_ENABLED", "true")
      System.put_env("HUB_BASE_URL", "http://localhost:19999")

      result =
        TestHubClient.call(%{
          prompt: "테스트 프롬프트",
          abstract_model: :anthropic_haiku,
          agent: "test_agent"
        })

      assert match?({:error, _}, result)
    after
      System.delete_env("HUB_BASE_URL")
    end
  end

  describe "normalize_hub_urgency/1" do
    test "Hub schema에 맞게 urgency 값을 정규화" do
      assert Jay.Core.LLM.HubClient.Impl.normalize_hub_urgency(:low) == "low"
      assert Jay.Core.LLM.HubClient.Impl.normalize_hub_urgency(:medium) == "normal"
      assert Jay.Core.LLM.HubClient.Impl.normalize_hub_urgency("normal") == "normal"
      assert Jay.Core.LLM.HubClient.Impl.normalize_hub_urgency(:high) == "high"
      assert Jay.Core.LLM.HubClient.Impl.normalize_hub_urgency(:urgent) == "critical"
      assert Jay.Core.LLM.HubClient.Impl.normalize_hub_urgency(:critical) == "critical"
      assert Jay.Core.LLM.HubClient.Impl.normalize_hub_urgency(:unexpected) == "normal"
      assert Jay.Core.LLM.HubClient.Impl.normalize_hub_urgency(nil) == "normal"
    end
  end

  describe "Hub admission backpressure contract" do
    test "503 admission response preserves retry metadata" do
      result =
        Jay.Core.LLM.HubClient.Impl.parse_http_response(
          503,
          %{
            "ok" => false,
            "error" => %{"code" => "queue_timeout", "message" => "queue wait timeout"},
            "retryAfterMs" => 1_800
          },
          "2"
        )

      assert {:error, {:hub_backpressure, meta}} = result
      assert meta.status == 503
      assert meta.code == "queue_timeout"
      assert meta.retry_after_ms == 1_800
      assert Jay.Core.LLM.HubClient.Impl.backpressure_reason?({:hub_backpressure, meta})
    end

    test "legacy 200 ok:false shared limiter response remains backpressure" do
      result =
        Jay.Core.LLM.HubClient.Impl.parse_http_response(
          200,
          %{"ok" => false, "error" => "shared_limiter_full:team:investment"},
          nil
        )

      assert {:error, {:hub_backpressure, %{code: "shared_limiter_full:team:investment"}}} =
               result
    end

    test "legacy 200 provider backpressure prevents direct fallback" do
      result =
        Jay.Core.LLM.HubClient.Impl.parse_http_response(
          200,
          %{
            "ok" => false,
            "error" => "fallback_exhausted: Groq 429",
            "providerBackpressure" => %{
              "kind" => "provider_rate_limit",
              "retryAfterMs" => 60_000,
              "httpStatus" => 429
            }
          },
          nil
        )

      assert {:error, {:hub_backpressure, meta}} = result
      assert meta.code == "provider_rate_limit"
      assert meta.retry_after_ms == 60_000
    end

    test "legacy boolean provider backpressure remains parseable" do
      result =
        Jay.Core.LLM.HubClient.Impl.parse_http_response(
          200,
          %{"ok" => false, "error" => "provider unavailable", "providerBackpressure" => true},
          nil
        )

      assert {:error, {:hub_backpressure, %{retry_after_ms: 0}}} = result
    end

    test "central cycle and job policy failures prevent direct fallback" do
      for code <- [
            "budget_exceeded",
            "cycle_budget_exceeded",
            "job_enqueue_failed",
            "token_budget_exceeded"
          ] do
        result =
          Jay.Core.LLM.HubClient.Impl.parse_http_response(
            503,
            %{"ok" => false, "error" => %{"code" => code}},
            nil
          )

        assert {:error, {:hub_backpressure, %{code: ^code}}} = result
      end
    end
  end

  describe "use macro 주입 확인" do
    test "enabled?/0 함수 존재" do
      assert function_exported?(TestHubClient, :enabled?, 0)
    end

    test "shadow?/0 함수 존재" do
      assert function_exported?(TestHubClient, :shadow?, 0)
    end

    test "call/1 함수 존재" do
      assert function_exported?(TestHubClient, :call, 1)
    end
  end
end
