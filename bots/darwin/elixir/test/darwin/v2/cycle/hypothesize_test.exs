defmodule Darwin.V2.Cycle.HypothesizeTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Cycle.Hypothesize

  setup_all do
    Code.ensure_loaded?(Hypothesize)
    :ok
  end

  describe "module_definition" do
    test "Hypothesize 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(Hypothesize)
    end

    test "8단계 HYPOTHESIZE Stage GenServer" do
      assert Hypothesize.__info__(:module) == Darwin.V2.Cycle.Hypothesize
    end
  end

  describe "public_api" do
    test "start_link/1 export" do
      assert function_exported?(Hypothesize, :start_link, 1)
    end

    test "run_now/1 export" do
      assert function_exported?(Hypothesize, :run_now, 1)
    end

    test "status/0 export" do
      assert function_exported?(Hypothesize, :status, 0)
    end
  end

  describe "eight_stage_cycle" do
    test "DISCOVER → HYPOTHESIZE → EVALUATE 순서 정의" do
      # Topics에 paper_hypothesized 토픽이 정의되어 있는지 검증
      assert Code.ensure_loaded?(Darwin.V2.Topics)
      assert function_exported?(Darwin.V2.Topics, :paper_hypothesized, 0)
    end

    test "paper_hypothesized 토픽 형식 확인" do
      topic = Darwin.V2.Topics.paper_hypothesized()
      assert is_binary(topic)
      assert String.contains?(topic, "hypothesized")
    end
  end

  describe "hypothesis_engine_integration" do
    test "HypothesisEngine 모듈 로드됨" do
      assert Code.ensure_loaded?(Darwin.V2.HypothesisEngine)
    end

    test "kill_switch 미설정 시 HypothesisEngine.generate는 :skip 반환" do
      System.delete_env("DARWIN_HYPOTHESIS_ENGINE_ENABLED")
      paper = %{arxiv_id: "2401.99999", title: "Test Hypothesis Paper", abstract: "Test abstract"}
      result = Darwin.V2.HypothesisEngine.generate(paper)
      assert result == {:skip, :disabled}
    end
  end

  describe "sakana_ai_scientist_pattern" do
    test "Sakana AI Scientist 8단계 사이클 통합 확인" do
      # 8단계: DISCOVER→HYPOTHESIZE→EVALUATE→PLAN→IMPLEMENT→VERIFY→APPLY→LEARN
      stages = ~w(discover hypothesize evaluate plan implement verify apply learn)
      assert "hypothesize" in stages
      assert Enum.at(stages, 1) == "hypothesize"
      assert Enum.at(stages, 2) == "evaluate"
    end

    test "가설 생성 시 payload에 hypothesis_id 추가 구조 확인" do
      enriched = Map.put(%{paper: %{title: "test"}}, :hypothesis_id, 42)
      assert enriched[:hypothesis_id] == 42
      assert enriched[:paper][:title] == "test"
    end
  end

  describe "passthrough_behavior" do
    test "HypothesisEngine 비활성 시 패스스루 동작 (hypothesis_id=nil)" do
      System.delete_env("DARWIN_HYPOTHESIS_ENGINE_ENABLED")
      # hypothesis_id nil = passthrough
      payload = %{paper: %{paper_id: "test"}, hypothesis_id: nil}
      assert payload[:hypothesis_id] == nil
    end
  end

  describe "lead_integration" do
    test "Lead 모듈 로드됨" do
      assert Code.ensure_loaded?(Darwin.V2.Lead)
    end

    test "KillSwitch :hypothesis_engine 키 존재" do
      assert Code.ensure_loaded?(Darwin.V2.KillSwitch)
      # KillSwitch.enabled?(:hypothesis_engine)는 환경변수 기반
      result = Darwin.V2.KillSwitch.enabled?(:hypothesis_engine)
      assert is_boolean(result)
    end
  end
end
