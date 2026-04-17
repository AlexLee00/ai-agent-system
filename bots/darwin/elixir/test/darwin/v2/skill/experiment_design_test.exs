defmodule Darwin.V2.Skill.ExperimentDesignTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Skill.ExperimentDesign

  setup_all do
    Code.ensure_loaded?(Darwin.V2.Skill.ExperimentDesign)
    :ok
  end

  describe "module_definition" do
    test "ExperimentDesign 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(ExperimentDesign)
    end
  end

  describe "jido_action_pattern" do
    test "run/2 함수 export" do
      assert function_exported?(ExperimentDesign, :run, 2)
    end
  end

  describe "namespace" do
    test "Darwin.V2.Skill 네임스페이스" do
      assert String.starts_with?(to_string(ExperimentDesign), "Elixir.Darwin.V2.Skill")
    end
  end

  describe "research_experiment_purpose" do
    test "연구 실험 설계 목적 (시그마의 비즈니스 실험과 구분)" do
      assert Code.ensure_loaded?(ExperimentDesign)
    end
  end

  describe "function_existence" do
    test "run/2는 2-arity 함수" do
      assert function_exported?(ExperimentDesign, :run, 2)
    end

    test "모듈 공개 함수 리스트" do
      fns = ExperimentDesign.__info__(:functions)
      assert :run in Keyword.keys(fns)
    end
  end

  describe "moduledoc" do
    test "모듈 문서 존재" do
      {:docs_v1, _, _, _, module_doc, _, _} = Code.fetch_docs(ExperimentDesign)
      assert module_doc != :none
    end
  end
end
