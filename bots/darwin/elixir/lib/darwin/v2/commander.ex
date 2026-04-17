defmodule Darwin.V2.Commander do
  @moduledoc """
  다윈 V2 Commander — Jido.AI.Agent 기반 7단계 R&D 오케스트레이터.

  7단계 자율 사이클 관장:
  DISCOVER → EVALUATE → PLAN → IMPLEMENT → VERIFY → APPLY → LEARN

  Phase 1: 기본 Jido.AI.Agent 골격 + decide_research_focus/2
  Phase 3: 7단계 사이클 완전 자율 연동
  Phase 4: Reflexion + SelfRAG 통합
  """

  use Jido.AI.Agent,
    name: "darwin_v2_commander",
    model: :smart,
    tools: [],
    system_prompt: """
    당신은 다윈팀 Commander v2입니다. AI 연구 자동화 에이전트 시스템의 오케스트레이터로,
    매일 새로운 AI 논문을 수집·평가·구현하는 7단계 자율 연구 사이클을 관장합니다.

    원칙:
    - P-D001: 표절 금지 — 논문 코드 그대로 복사 금지
    - P-D002: 검증 없이 main 적용 금지
    - P-D003: 재현 불가 실험 결과 폐기
    - P-D004: 일일 LLM 비용 $10 초과 금지
    - P-D005: 자율 레벨 L5 미달 시 마스터 승인 필요

    판단 전 반드시 자기 비판(Principle.Loader.self_critique) 수행.
    """

  require Logger

  # -------------------------------------------------------------------
  # 공개 API
  # -------------------------------------------------------------------

  @doc "오늘의 연구 초점 결정 — 수집된 논문 기반 우선순위 설정."
  @spec decide_research_focus(Date.t(), [map()]) :: {:ok, map()} | {:error, term()}
  def decide_research_focus(date \\ Date.utc_today(), recent_papers \\ []) do
    reflexion_context =
      case Darwin.V2.Memory.L1.recall(:reflection, limit: 3, min_importance: 0.7) do
        entries when is_list(entries) -> Enum.map(entries, & &1.content)
        _ -> []
      end

    paper_summaries =
      recent_papers
      |> Enum.take(10)
      |> Enum.map(fn p ->
        "- #{p[:title] || p["title"] || "unknown"} (점수: #{p[:score] || p["score"] || "N/A"})"
      end)
      |> Enum.join("\n")

    prompt = """
    다윈 연구팀의 오늘(#{Date.to_iso8601(date)}) 연구 초점을 결정하세요.

    최근 수집된 논문:
    #{if paper_summaries == "", do: "없음", else: paper_summaries}

    과거 반성 메모:
    #{if reflexion_context == [], do: "없음", else: Enum.join(Enum.map(reflexion_context, &inspect/1), "\n")}

    다음 형식으로 답하세요:
    1. 오늘 우선 연구 주제 (1줄)
    2. 핵심 키워드 3개 (쉼표 구분)
    3. 예상 구현 난이도 (easy/medium/hard)
    """

    case Darwin.V2.LLM.Selector.call_with_fallback("commander", prompt,
           max_tokens: 300,
           task_type: :structured_reasoning
         ) do
      {:ok, %{response: text}} ->
        focus = parse_research_focus(text, date)
        Darwin.V2.Memory.L1.store(:plan, focus, importance: 0.9)
        {:ok, focus}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc "구현 계획에 원칙 게이트 적용."
  @spec apply_principle_gate(map()) :: {:approved, []} | {:blocked, [map()]}
  def apply_principle_gate(plan) do
    Darwin.V2.Principle.Loader.self_critique(plan)
  end

  @doc "JayBus로 연구 사이클 이벤트 브로드캐스트."
  @spec broadcast(String.t(), map()) :: :ok
  def broadcast(topic, payload) do
    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries do
        send(pid, {:jay_event, topic, payload})
      end
    end)

    :ok
  end

  # -------------------------------------------------------------------
  # Private
  # -------------------------------------------------------------------

  defp parse_research_focus(text, date) do
    lines =
      text
      |> String.split("\n", trim: true)
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == ""))

    %{
      date:       Date.to_iso8601(date),
      focus:      Enum.at(lines, 0, "자율 연구"),
      keywords:   parse_keywords(Enum.at(lines, 1, "")),
      difficulty: parse_difficulty(Enum.at(lines, 2, "medium")),
      raw:        text
    }
  end

  defp parse_keywords(line) do
    line
    |> String.replace(~r/^\d+\.\s*/, "")
    |> String.split(",", trim: true)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end

  defp parse_difficulty(line) do
    cond do
      line =~ ~r/easy/i   -> :easy
      line =~ ~r/hard/i   -> :hard
      true                -> :medium
    end
  end
end
