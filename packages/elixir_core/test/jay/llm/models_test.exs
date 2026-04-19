defmodule Jay.Core.LLM.ModelsTest do
  use ExUnit.Case, async: true

  alias Jay.Core.LLM.Models

  describe "get_current/1" do
    test "anthropic_haiku → Claude haiku 모델 ID" do
      model = Models.get_current("anthropic_haiku")
      assert is_binary(model)
      assert String.contains?(model, "haiku") or String.contains?(model, "claude")
    end

    test "anthropic_sonnet → Claude sonnet 모델 ID" do
      model = Models.get_current("anthropic_sonnet")
      assert is_binary(model)
      assert String.contains?(model, "sonnet") or String.contains?(model, "claude")
    end

    test "anthropic_opus → Claude opus 모델 ID" do
      model = Models.get_current("anthropic_opus")
      assert is_binary(model)
      assert String.contains?(model, "opus") or String.contains?(model, "claude")
    end

    test "알 수 없는 모델 → 기본값 반환 (nil 아님)" do
      model = Models.get_current("unknown_model_xyz")
      assert is_binary(model)
      refute is_nil(model)
    end

    test "각 추상 모델별 고유 ID" do
      haiku  = Models.get_current("anthropic_haiku")
      sonnet = Models.get_current("anthropic_sonnet")
      opus   = Models.get_current("anthropic_opus")
      assert haiku != sonnet
      assert sonnet != opus
    end
  end

  describe "get_groq_fallback/1" do
    test "anthropic_haiku → Groq 경량 모델" do
      model = Models.get_groq_fallback("anthropic_haiku")
      assert is_binary(model)
      assert String.length(model) > 0
    end

    test "anthropic_sonnet → Groq 중형 모델" do
      model = Models.get_groq_fallback("anthropic_sonnet")
      assert is_binary(model)
    end

    test "anthropic_opus → Groq 대형 모델" do
      model = Models.get_groq_fallback("anthropic_opus")
      assert is_binary(model)
    end

    test "알 수 없는 모델 → 기본값 반환" do
      model = Models.get_groq_fallback("unknown_model")
      assert is_binary(model)
      refute is_nil(model)
    end

    test "Groq 모델은 Anthropic 모델 ID와 다름" do
      claude = Models.get_current("anthropic_haiku")
      groq   = Models.get_groq_fallback("anthropic_haiku")
      assert claude != groq
    end
  end

  describe "get_cost/3" do
    test "haiku 비용 계산 — 양수" do
      cost = Models.get_cost("anthropic_haiku", 1000, 500)
      assert is_float(cost)
      assert cost > 0.0
    end

    test "sonnet 비용 > haiku 비용 (동일 토큰)" do
      haiku_cost  = Models.get_cost("anthropic_haiku",  1000, 500)
      sonnet_cost = Models.get_cost("anthropic_sonnet", 1000, 500)
      assert sonnet_cost > haiku_cost
    end

    test "opus 비용 > sonnet 비용" do
      sonnet_cost = Models.get_cost("anthropic_sonnet", 1000, 500)
      opus_cost   = Models.get_cost("anthropic_opus",   1000, 500)
      assert opus_cost > sonnet_cost
    end

    test "토큰 0 → 비용 0" do
      assert Models.get_cost("anthropic_haiku", 0, 0) == 0.0
    end

    test "알 수 없는 모델 → 0.0" do
      assert Models.get_cost("unknown_xyz", 1000, 500) == 0.0
    end

    test "대량 토큰 비용 스케일" do
      cost = Models.get_cost("anthropic_opus", 1_000_000, 500_000)
      assert cost > 1.0
    end
  end

  describe "abstract_models/0" do
    test "3개 모델 반환" do
      models = Models.abstract_models()
      assert length(models) == 3
    end

    test "haiku/sonnet/opus 포함" do
      models = Models.abstract_models()
      assert "anthropic_haiku" in models
      assert "anthropic_sonnet" in models
      assert "anthropic_opus" in models
    end
  end

  describe "load_config/0" do
    test "map 반환" do
      config = Models.load_config()
      assert is_map(config)
    end

    test "models 키 포함" do
      config = Models.load_config()
      assert Map.has_key?(config, "models")
    end

    test "groq_fallback_models 키 포함" do
      config = Models.load_config()
      assert Map.has_key?(config, "groq_fallback_models")
    end
  end
end
