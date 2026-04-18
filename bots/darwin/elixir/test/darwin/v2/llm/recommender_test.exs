defmodule Darwin.V2.LLM.RecommenderTest do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded?(Darwin.V2.LLM.Recommender)
    :ok
  end

  describe "module_definition" do
    test "Recommender 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Darwin.V2.LLM.Recommender)
    end
  end

  describe "public_api" do
    test "recommend/2 함수 export" do
      assert function_exported?(Darwin.V2.LLM.Recommender, :recommend, 2)
    end
  end

  describe "recommend_behavior" do
    test "빈 context로 recommend 호출 가능" do
      result = Darwin.V2.LLM.Recommender.recommend("darwin.evaluator", %{})
      refute is_nil(result)
    end

    test "tokens 컨텍스트 전달" do
      result = Darwin.V2.LLM.Recommender.recommend("darwin.planner", %{tokens: 2000})
      refute is_nil(result)
    end

    test "budget_ratio 컨텍스트 전달" do
      result = Darwin.V2.LLM.Recommender.recommend("darwin.scanner", %{budget_ratio: 0.5})
      refute is_nil(result)
    end

    test "unknown agent도 반환값 존재" do
      result = Darwin.V2.LLM.Recommender.recommend("unknown_agent", %{})
      refute is_nil(result)
    end
  end

  describe "model_coverage" do
    test "Haiku 모델 선택 가능" do
      result = Darwin.V2.LLM.Recommender.recommend("darwin.scanner", %{budget_ratio: 0.9})
      refute is_nil(result)
    end

    test "Sonnet 모델 선택 가능" do
      result = Darwin.V2.LLM.Recommender.recommend("darwin.evaluator", %{tokens: 5000})
      refute is_nil(result)
    end

    test "Opus 모델 선택 가능" do
      result = Darwin.V2.LLM.Recommender.recommend("darwin.principle.critique", %{tokens: 10000})
      refute is_nil(result)
    end
  end

  describe "default_values" do
    test "context 생략 시 기본값 사용" do
      result = Darwin.V2.LLM.Recommender.recommend("darwin.evaluator")
      refute is_nil(result)
    end
  end
end
