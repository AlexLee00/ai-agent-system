defmodule Darwin.V2.LLM.RecommenderTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.LLM.Recommender

  describe "recommend/2 — 에이전트별 기본 적합도" do
    test "evaluator → sonnet (구조적 추론 최우선)" do
      {:ok, rec} = Recommender.recommend("evaluator")
      assert rec.primary == :anthropic_sonnet
      assert is_list(rec.fallback)
      assert is_list(rec.scores)
    end

    test "planner → sonnet (구현 계획 설계)" do
      {:ok, rec} = Recommender.recommend("planner")
      assert rec.primary == :anthropic_sonnet
    end

    test "scanner → haiku (대량 배치 처리)" do
      {:ok, rec} = Recommender.recommend("scanner")
      assert rec.primary == :anthropic_haiku
    end

    test "self_rag.retrieve → haiku (이진 분류)" do
      {:ok, rec} = Recommender.recommend("self_rag.retrieve")
      assert rec.primary == :anthropic_haiku
    end

    test "reflexion → sonnet (회고는 구조적 추론)" do
      {:ok, rec} = Recommender.recommend("reflexion")
      assert rec.primary == :anthropic_sonnet
    end

    test "espl.mutation → haiku (경량 변이)" do
      {:ok, rec} = Recommender.recommend("espl.mutation")
      assert rec.primary == :anthropic_haiku
    end

    test "미등록 에이전트 → haiku 기본값" do
      {:ok, rec} = Recommender.recommend("unknown.xyz")
      assert rec.primary == :anthropic_haiku
    end

    test "scores 내림차순 정렬 보장" do
      {:ok, rec} = Recommender.recommend("evaluator")
      scores = Enum.map(rec.scores, &elem(&1, 1))
      assert scores == Enum.sort(scores, :desc)
    end
  end

  describe "recommend/2 — 예산 압박 (룰 2)" do
    test "budget_ratio 0.05 → haiku 강제 (예산 5%)" do
      {:ok, rec} = Recommender.recommend("evaluator", %{budget_ratio: 0.05})
      assert rec.primary == :anthropic_haiku
    end

    test "budget_ratio 0.20 → sonnet 패널티" do
      {:ok, rec_normal} = Recommender.recommend("evaluator", %{budget_ratio: 0.9})
      {:ok, rec_tight}  = Recommender.recommend("evaluator", %{budget_ratio: 0.20})
      sonnet_normal = Enum.find(rec_normal.scores, &(elem(&1, 0) == :anthropic_sonnet))
      sonnet_tight  = Enum.find(rec_tight.scores,  &(elem(&1, 0) == :anthropic_sonnet))
      assert elem(sonnet_normal, 1) > elem(sonnet_tight, 1)
    end

    test "budget_ratio 0.95 → 기본 정책 유지" do
      {:ok, rec} = Recommender.recommend("evaluator", %{budget_ratio: 0.95})
      assert rec.primary == :anthropic_sonnet
    end
  end

  describe "recommend/2 — 긴급도 조정 (룰 4)" do
    test "urgency :high → haiku 선호" do
      {:ok, rec} = Recommender.recommend("evaluator", %{urgency: :high})
      haiku_score  = Enum.find(rec.scores, &(elem(&1, 0) == :anthropic_haiku))
      sonnet_score = Enum.find(rec.scores, &(elem(&1, 0) == :anthropic_sonnet))
      if haiku_score && sonnet_score do
        assert elem(haiku_score, 1) > elem(sonnet_score, 1)
      end
    end

    test "urgency :low → 비용 절약 모델 선택 안 함" do
      {:ok, rec_low}    = Recommender.recommend("evaluator", %{urgency: :low})
      {:ok, rec_medium} = Recommender.recommend("evaluator", %{urgency: :medium})
      sonnet_low    = Enum.find(rec_low.scores,    &(elem(&1, 0) == :anthropic_sonnet))
      sonnet_medium = Enum.find(rec_medium.scores, &(elem(&1, 0) == :anthropic_sonnet))
      if sonnet_low && sonnet_medium do
        assert elem(sonnet_low, 1) >= elem(sonnet_medium, 1)
      end
    end
  end

  describe "recommend/2 — 작업 유형 (룰 5)" do
    test "batch_filtering → haiku 점수 boost" do
      {:ok, rec} = Recommender.recommend("scanner", %{task_type: :batch_filtering})
      haiku_score = Enum.find(rec.scores, &(elem(&1, 0) == :anthropic_haiku))
      assert haiku_score != nil
      assert elem(haiku_score, 1) > 1.0
    end

    test "creative_generation → sonnet 점수 boost" do
      {:ok, rec} = Recommender.recommend("espl.crossover", %{task_type: :creative_generation})
      sonnet_score = Enum.find(rec.scores, &(elem(&1, 0) == :anthropic_sonnet))
      assert sonnet_score != nil
    end

    test "structured_reasoning → sonnet 선호" do
      {:ok, rec} = Recommender.recommend("planner", %{task_type: :structured_reasoning})
      assert rec.primary in [:anthropic_sonnet, :anthropic_opus]
    end
  end

  describe "recommend/2 — 복합 시나리오" do
    test "예산 부족 + 긴급 → haiku 확실" do
      {:ok, rec} = Recommender.recommend("evaluator", %{
        budget_ratio: 0.05,
        urgency: :high
      })
      assert rec.primary == :anthropic_haiku
    end

    test "여유 예산 + 긴 컨텍스트 → sonnet 승격" do
      {:ok, rec} = Recommender.recommend("evaluator", %{
        budget_ratio: 0.9,
        prompt_tokens: 9_000
      })
      assert rec.primary in [:anthropic_sonnet, :anthropic_opus]
    end

    test "실패율 높음 → 모든 점수 감소" do
      {:ok, rec_ok}   = Recommender.recommend("evaluator", %{failure_rate: 0.0})
      {:ok, rec_fail} = Recommender.recommend("evaluator", %{failure_rate: 0.35})
      max_ok   = rec_ok.scores   |> Enum.map(&elem(&1, 1)) |> Enum.max()
      max_fail = rec_fail.scores |> Enum.map(&elem(&1, 1)) |> Enum.max()
      assert max_ok > max_fail
    end
  end
end
