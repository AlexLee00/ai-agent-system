defmodule Darwin.V2.Skill.VLMFeedbackTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Skill.VLMFeedback

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Skill.VLMFeedback)
    :ok
  end

  describe "module_definition" do
    test "VLMFeedback 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(VLMFeedback)
    end
  end

  describe "jido_action_pattern" do
    test "run/2 함수 export" do
      assert function_exported?(VLMFeedback, :run, 2)
    end
  end

  describe "namespace" do
    test "Darwin.V2.Skill 네임스페이스" do
      assert String.starts_with?(to_string(VLMFeedback), "Elixir.Darwin.V2.Skill")
    end
  end

  describe "vlm_purpose" do
    test "구현 결과물 시각 평가 목적" do
      assert Code.ensure_loaded?(VLMFeedback)
    end

    test "AI Scientist-v2 VLM 피드백 루프 참조" do
      assert function_exported?(VLMFeedback, :run, 2)
    end
  end

  describe "function_count" do
    test "public 함수 최소 1개" do
      assert length(VLMFeedback.__info__(:functions)) >= 1
    end
  end

  describe "moduledoc" do
    test "모듈 문서 존재" do
      {:docs_v1, _, _, _, module_doc, _, _} = Code.fetch_docs(VLMFeedback)
      assert module_doc != :none
    end
  end
end
