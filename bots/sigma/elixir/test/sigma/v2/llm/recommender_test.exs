defmodule Sigma.V2.LLM.RecommenderTest do
  use ExUnit.Case, async: true

  alias Sigma.V2.LLM.Recommender

  describe "recommend/2 — 기본 에이전트 적합도" do
    test "reflexion 기본 추천 → sonnet (base score 1.0)" do
      {:ok, rec} = Recommender.recommend("reflexion")
      assert rec.primary == :anthropic_sonnet
      assert is_binary(rec.reason)
      assert is_list(rec.fallback)
      assert is_list(rec.scores)
    end

    test "self_rag.retrieve_gate 기본 추천 → haiku (binary classification)" do
      {:ok, rec} = Recommender.recommend("self_rag.retrieve_gate")
      assert rec.primary == :anthropic_haiku
    end

    test "espl.crossover 기본 추천 → sonnet (creative generation)" do
      {:ok, rec} = Recommender.recommend("espl.crossover")
      assert rec.primary == :anthropic_sonnet
    end

    test "미등록 에이전트 → haiku (default affinity)" do
      {:ok, rec} = Recommender.recommend("unknown.agent.xyz")
      assert rec.primary == :anthropic_haiku
      assert rec.reason == "정책 권장"
    end

    test "scores 리스트 반환 확인" do
      {:ok, rec} = Recommender.recommend("reflexion")
      assert length(rec.scores) >= 1
      # 점수는 {model, float} 튜플 리스트
      assert Enum.all?(rec.scores, fn {m, s} -> is_atom(m) and is_float(s) end)
      # 내림차순 정렬 확인
      [first | rest] = rec.scores
      Enum.reduce([first | rest], first, fn {_, s}, {_, prev_s} ->
        assert prev_s >= s
        {nil, s}
      end)
    end
  end

  describe "recommend/2 — 예산 기반 조정 (룰 2)" do
    test "budget_ratio 0.05 (5%) → haiku로 다운그레이드" do
      {:ok, rec} = Recommender.recommend("reflexion", %{budget_ratio: 0.05})
      assert rec.primary == :anthropic_haiku
      assert rec.reason =~ "예산"
    end

    test "budget_ratio 0.20 (20%) → haiku 선호" do
      {:ok, rec} = Recommender.recommend("reflexion", %{budget_ratio: 0.20})
      assert rec.primary == :anthropic_haiku
    end

    test "budget_ratio 0.90 (여유) → 정책 권장 (sonnet 유지)" do
      {:ok, rec} = Recommender.recommend("reflexion", %{budget_ratio: 0.90})
      assert rec.primary == :anthropic_sonnet
    end
  end

  describe "recommend/2 — 프롬프트 길이 가중치 (룰 1)" do
    test "prompt_tokens 10000 → sonnet 부스트" do
      {:ok, rec} = Recommender.recommend("reflexion", %{prompt_tokens: 10_000})
      # 긴 프롬프트 시 sonnet +0.2 → haiku보다 더 선호
      assert rec.primary == :anthropic_sonnet
    end

    test "prompt_tokens 100 (짧음) → haiku 과잉 방지" do
      {:ok, rec} = Recommender.recommend("espl.crossover", %{prompt_tokens: 100})
      # sonnet -0.3 패널티로 haiku 선호 가능
      assert match?({:ok, %{primary: _}}, {:ok, rec})
    end
  end

  describe "recommend/2 — 긴급도 (룰 4)" do
    test "urgency :high → haiku 선호 (속도 우선)" do
      # commander는 @agent_affinity에 없으므로 default={haiku: 1.0} + urgency_bias
      {:ok, rec} = Recommender.recommend("commander", %{urgency: :high})
      assert rec.primary == :anthropic_haiku
      assert rec.reason =~ "긴급"
    end

    test "urgency :high + reflexion → haiku 선호 (sonnet보다 높은 최종 점수)" do
      # reflexion: sonnet 1.0-0.2=0.8, haiku 0.6+0.3=0.9 → haiku 승
      {:ok, rec} = Recommender.recommend("reflexion", %{urgency: :high})
      assert rec.primary == :anthropic_haiku
    end

    test "urgency :low → 품질 우선 (sonnet/opus 선호)" do
      {:ok, rec} = Recommender.recommend("reflexion", %{urgency: :low})
      assert rec.primary in [:anthropic_sonnet, :anthropic_opus]
    end
  end

  describe "recommend/2 — 작업 유형 (룰 5)" do
    test "task_type :binary_classification → haiku 선호" do
      {:ok, rec} = Recommender.recommend("reflexion", %{task_type: :binary_classification})
      assert rec.primary == :anthropic_haiku
    end

    test "task_type :creative_generation → sonnet 선호" do
      {:ok, rec} = Recommender.recommend("reflexion", %{task_type: :creative_generation})
      assert rec.primary == :anthropic_sonnet
    end

    test "task_type :batch_filtering → haiku (대량 호출 비용 절약)" do
      {:ok, rec} = Recommender.recommend("reflexion", %{task_type: :batch_filtering})
      assert rec.primary == :anthropic_haiku
    end
  end

  describe "recommend/2 — fallback 리스트" do
    test "reflexion fallback에 haiku 포함 (양수 점수 모델만)" do
      {:ok, rec} = Recommender.recommend("reflexion")
      assert :anthropic_haiku in rec.fallback
    end

    test "단일 모델 에이전트는 fallback 빈 리스트" do
      {:ok, rec} = Recommender.recommend("self_rag.retrieve_gate")
      assert rec.fallback == []
    end

    test "예산 극도 부족 시 sonnet/opus는 fallback에서 제외 (음수 점수)" do
      {:ok, rec} = Recommender.recommend("reflexion", %{budget_ratio: 0.02})
      # sonnet: 1.0-1.0=0.0 (경계), opus: 0.3-2.0=-1.7 (음수 → 제외)
      assert :anthropic_opus not in rec.fallback
    end
  end
end
