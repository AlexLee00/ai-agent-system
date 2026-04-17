defmodule Darwin.V2.Commander do
  @moduledoc """
  다윈 V2 Commander — Jido.AI.Agent 기반 7단계 R&D 파이프라인 오케스트레이터.

  7단계 자율 사이클 관장:
  DISCOVER → EVALUATE → PLAN → IMPLEMENT → VERIFY → APPLY → LEARN

  ## 역할
  - plan_pipeline/2:    평가된 논문 중 구현 대상 선정 + 우선순위 + 전략 수립
  - analyze_results/2:  구현 결과 분석 → apply/defer/discard 판정
  - decide_learning/2:  사이클 종료 후 학습 내용 결정 (키워드·임계값 업데이트)

  ## V2 통합
  - Memory.L1 (세션) + Memory.L2 (SelfRAG, 재구현 방지)
  - Principle.Loader.check/2 (원칙 게이트)
  - LLM.Selector.call_with_fallback/3 ("darwin.commander" 정책)
  - JayBus 브로드캐스트 via Registry

  모든 LLM 호출: darwin.commander 에이전트 → claude-opus-4-7 (폴백: sonnet)
  """

  use Jido.AI.Agent,
    name: "darwin_commander",
    model: :smart,
    tools: [
      Darwin.V2.Skill.ResourceAnalyst,
      Darwin.V2.Skill.PaperSynthesis,
      Darwin.V2.Skill.TreeSearch
    ],
    system_prompt: """
    당신은 다윈팀 Commander v2입니다. AI 연구 자동화 에이전트 시스템의 오케스트레이터로,
    매일 새로운 AI 논문을 수집·평가·구현하는 7단계 자율 연구 사이클을 관장합니다.

    ## 7단계 사이클
    1. DISCOVER  — arXiv/HN/Reddit에서 관련 논문 수집
    2. EVALUATE  — 적합성 점수 산정 (0~10점, 7점 이상 구현 후보)
    3. PLAN      — 구현 대상 선정 + 전략 수립 (memory로 재구현 방지)
    4. IMPLEMENT — Edison이 코드 구현 + 유닛 테스트
    5. VERIFY    — 재현 가능성 + 성능 측정 + 검증
    6. APPLY     — 메인 시스템에 반영 (검증 통과 시만)
    7. LEARN     — 키워드 진화 + 임계값 조정 + 교훈 기록

    ## 자율 레벨 원칙
    - L3: 구현 전 마스터 승인 필요
    - L4: 구현 자동 진행, 적용 전 승인 필요
    - L5: 완전 자율 (검증 통과 시 자동 적용)

    ## 연구 원칙 (Constitutional)
    - P-D001: 표절 금지 — 논문 코드 그대로 복사 금지
    - P-D002: 검증 없이 main 적용 금지
    - P-D003: 재현 불가 실험 결과 폐기 (3회 시도 후)
    - P-D004: 일일 LLM 비용 $10 초과 금지
    - P-D005: 자율 레벨 L5 미달 시 마스터 승인 필요

    판단 전 반드시 자기 비판(Principle.Loader.check) 수행.
    Memory L2에서 과거 실패 패턴 조회 후 중복 구현 방지.
    """

  require Logger

  # ──────────────────────────────────────────────
  # Public API
  # ──────────────────────────────────────────────

  @doc """
  평가된 논문 목록에서 구현 대상 선정 + 전략 수립.

  - Memory.L2 SelfRAG로 이미 실패한 논문 재구현 방지
  - 원칙 게이트 통과 확인
  - 예상 비용 추정 포함

  Returns: %{to_implement: [...], strategy: String.t(), estimated_cost: float()}
  """
  @spec plan_pipeline([map()], keyword()) ::
          {:ok, %{to_implement: [map()], strategy: String.t(), estimated_cost: float()}}
          | {:blocked, [String.t()]}
          | {:error, term()}
  def plan_pipeline(papers, opts \\ []) do
    # 1) 원칙 게이트 — plan_pipeline 액션 검사
    case Darwin.V2.Principle.Loader.check("plan_pipeline", %{papers: length(papers)}) do
      {:blocked, violations} ->
        Logger.warning("[다윈V2 커맨더] plan_pipeline 원칙 차단: #{inspect(violations)}")
        {:blocked, violations}

      {:approved, _} ->
        do_plan_pipeline(papers, opts)
    end
  end

  @doc """
  구현 결과 분석 → apply/defer/discard 판정.

  Returns: %{verdict: :apply | :defer | :discard, reason: String.t(), confidence: float()}
  """
  @spec analyze_results(map(), keyword()) ::
          {:ok, %{verdict: :apply | :defer | :discard, reason: String.t(), confidence: float()}}
          | {:error, term()}
  def analyze_results(implementation_result, _opts \\ []) do
    paper = implementation_result[:paper] || implementation_result["paper"] || %{}
    paper_title = paper[:title] || paper["title"] || "unknown"
    metrics = implementation_result[:metrics] || implementation_result["metrics"] || %{}
    passed = implementation_result[:verified] || implementation_result["verified"] || false
    error = implementation_result[:error] || implementation_result["error"]

    # 과거 유사 구현 메모리 조회
    past_context =
      case recall_similar("analyze results #{paper_title}", limit: 3) do
        {:ok, hits} -> Enum.map(hits, &"- #{&1[:content] || &1["content"] || ""}") |> Enum.join("\n")
        _ -> "없음"
      end

    prompt = """
    다윈팀 구현 결과를 분석하여 메인 적용 여부를 판정하세요.

    논문: #{paper_title}
    검증 통과: #{passed}
    성능 지표: #{inspect(metrics)}
    오류: #{inspect(error)}

    과거 유사 구현:
    #{past_context}

    다음 JSON 형식으로 답하세요:
    {
      "verdict": "apply" | "defer" | "discard",
      "reason": "판정 근거 (1~2문장)",
      "confidence": 0.0~1.0
    }

    판정 기준:
    - apply:   검증 통과 + 성능 개선 확인 + 원칙 위반 없음
    - defer:   잠재력 있으나 추가 검증/개선 필요
    - discard: 재현 불가 or 성능 저하 or 원칙 위반
    """

    case Darwin.V2.LLM.Selector.call_with_fallback("darwin.commander", prompt,
           max_tokens: 300,
           task_type: :structured_reasoning
         ) do
      {:ok, %{response: text}} ->
        result = parse_analysis_result(text)

        # L2 메모리 저장 (분석 결과 학습)
        store_memory(
          "analyze_results #{paper_title}: #{result.verdict}",
          :implementation_strategy,
          %{paper_title: paper_title, verdict: result.verdict, metrics: metrics},
          importance: if(result.verdict == :apply, do: 0.8, else: 0.6)
        )

        {:ok, result}

      {:error, reason} ->
        Logger.error("[다윈V2 커맨더] analyze_results LLM 실패: #{inspect(reason)}")
        {:error, reason}
    end
  end

  @doc """
  전체 사이클 종료 후 학습 내용 결정.
  키워드 업데이트, 평가 임계값 조정, 교훈 기록.

  Returns: %{keyword_updates: [...], threshold_adjustment: float(), lessons: [...]}
  """
  @spec decide_learning(map(), keyword()) ::
          {:ok, %{keyword_updates: [String.t()], threshold_adjustment: float(), lessons: [String.t()]}}
          | {:error, term()}
  def decide_learning(cycle_summary, _opts \\ []) do
    successes   = cycle_summary[:successes] || cycle_summary["successes"] || 0
    failures    = cycle_summary[:failures]  || cycle_summary["failures"]  || 0
    applied     = cycle_summary[:applied]   || cycle_summary["applied"]   || []
    discarded   = cycle_summary[:discarded] || cycle_summary["discarded"] || []
    top_papers  = cycle_summary[:top_papers] || cycle_summary["top_papers"] || []

    # 과거 학습 메모리 조회
    past_lessons =
      case recall_similar("learning keyword evolution", limit: 5) do
        {:ok, hits} -> Enum.map(hits, &"- #{&1[:content] || &1["content"] || ""}") |> Enum.join("\n")
        _ -> "없음"
      end

    prompt = """
    다윈팀이 이번 연구 사이클에서 무엇을 배워야 하는지 결정하세요.

    사이클 요약:
    - 성공: #{successes}건
    - 실패: #{failures}건
    - 적용된 논문: #{inspect(applied)}
    - 폐기된 논문: #{inspect(discarded)}
    - 주요 논문 제목: #{inspect(top_papers)}

    과거 교훈:
    #{past_lessons}

    다음 JSON 형식으로 답하세요:
    {
      "keyword_updates": ["추가할 키워드1", "추가할 키워드2"],
      "threshold_adjustment": -0.5 ~ +0.5 (현재 임계값 7.0 기준 조정량),
      "lessons": ["교훈1", "교훈2", "교훈3"]
    }
    """

    case Darwin.V2.LLM.Selector.call_with_fallback("darwin.commander", prompt,
           max_tokens: 500,
           task_type: :structured_reasoning
         ) do
      {:ok, %{response: text}} ->
        result = parse_learning_result(text)

        # L1 세션 메모리에 저장
        Darwin.V2.Memory.L1.store(:plan, result, importance: 0.9)

        # L2 장기 메모리에 저장
        lesson_text = Enum.join(result.lessons, " | ")
        store_memory(
          "사이클 학습 결과: #{lesson_text}",
          :evaluation_pattern,
          %{cycle_summary: cycle_summary, result: result},
          importance: 0.8
        )

        {:ok, result}

      {:error, reason} ->
        Logger.error("[다윈V2 커맨더] decide_learning LLM 실패: #{inspect(reason)}")
        {:error, reason}
    end
  end

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

    case Darwin.V2.LLM.Selector.call_with_fallback("darwin.commander", prompt,
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

  @doc "원칙 게이트 적용."
  @spec apply_principle_gate(map()) :: {:approved, []} | {:blocked, [String.t()]}
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

  # ──────────────────────────────────────────────
  # Private — plan_pipeline 실제 구현
  # ──────────────────────────────────────────────

  defp do_plan_pipeline(papers, _opts) do
    # 점수 7 이상 후보 필터
    candidates = Enum.filter(papers, fn p ->
      score = p[:score] || p["score"] || 0
      score >= 7
    end)

    if candidates == [] do
      Logger.info("[다윈V2 커맨더] 구현 후보 논문 없음 (7점 이상 0건)")
      {:ok, %{to_implement: [], strategy: "구현 후보 없음", estimated_cost: 0.0}}
    else
      # Memory L2 SelfRAG: 과거 실패 논문 조회 (재구현 방지)
      already_failed = recall_failed_papers(candidates)

      filtered = Enum.reject(candidates, fn p ->
        pid = p[:id] || p["id"] || ""
        MapSet.member?(already_failed, pid)
      end)

      skipped = length(candidates) - length(filtered)
      if skipped > 0 do
        Logger.info("[다윈V2 커맨더] 과거 실패 논문 #{skipped}건 재구현 방지로 제외")
      end

      if filtered == [] do
        {:ok, %{to_implement: [], strategy: "모든 후보가 과거 실패 기록 있음", estimated_cost: 0.0}}
      else
        build_plan(filtered)
      end
    end
  end

  defp build_plan(papers) do
    paper_list =
      papers
      |> Enum.take(5)
      |> Enum.map(fn p ->
        "- #{p[:title] || p["title"] || "unknown"} (점수: #{p[:score] || p["score"] || "N/A"})"
      end)
      |> Enum.join("\n")

    prompt = """
    다음 논문들의 구현 계획을 수립하세요.

    구현 후보 논문:
    #{paper_list}

    각 논문에 대해 다음을 결정하세요:
    1. 구현 순서 (우선순위 기준: 영향도 × 구현 가능성)
    2. 구현 전략 (어떤 컴포넌트를 어떻게 구현할지)
    3. 예상 LLM 비용 ($, 논문당)

    JSON 형식으로 답하세요:
    {
      "strategy": "전체 전략 (2~3문장)",
      "order": ["제목1", "제목2", ...],
      "estimated_cost": 0.0
    }
    """

    case Darwin.V2.LLM.Selector.call_with_fallback("darwin.commander", prompt,
           max_tokens: 600,
           task_type: :structured_reasoning
         ) do
      {:ok, %{response: text}} ->
        parsed = parse_plan_result(text)
        result = %{
          to_implement: papers,
          strategy:     parsed[:strategy] || "우선순위 기반 구현",
          estimated_cost: parsed[:estimated_cost] || length(papers) * 0.5
        }
        {:ok, result}

      {:error, reason} ->
        Logger.error("[다윈V2 커맨더] plan_pipeline LLM 실패: #{inspect(reason)}")
        # LLM 실패 시 단순 순서로 플랜 반환
        {:ok, %{
          to_implement: papers,
          strategy:     "점수 순 구현 (LLM 계획 실패로 폴백)",
          estimated_cost: length(papers) * 0.5
        }}
    end
  end

  defp recall_failed_papers(candidates) do
    Enum.reduce(candidates, MapSet.new(), fn paper, acc ->
      title = paper[:title] || paper["title"] || ""
      case recall_similar("failure #{title}", limit: 3) do
        {:ok, hits} ->
          Enum.reduce(hits, acc, fn hit, inner ->
            ctx = hit[:context] || hit["context"] || %{}
            paper_id = ctx[:paper_id] || ctx["paper_id"] || ""
            if paper_id != "", do: MapSet.put(inner, paper_id), else: inner
          end)
        _ -> acc
      end
    end)
  end

  # ──────────────────────────────────────────────
  # Private — 메모리 헬퍼
  # ──────────────────────────────────────────────

  defp recall_similar(query, opts) do
    limit = Keyword.get(opts, :limit, 5)
    Darwin.V2.Memory.L2.run(
      %{operation: :retrieve, content: query, team: "darwin", top_k: limit},
      %{}
    )
  end

  defp store_memory(content, memory_type, context, opts) do
    importance = Keyword.get(opts, :importance, 0.6)
    Darwin.V2.Memory.L2.store("darwin", content, memory_type,
      importance: importance,
      context: context,
      tags: [to_string(memory_type), "commander"]
    )
  rescue
    _ -> :ok
  end

  # ──────────────────────────────────────────────
  # Private — 파싱
  # ──────────────────────────────────────────────

  defp parse_plan_result(text) do
    with {:ok, json} <- extract_json(text),
         {:ok, data} <- Jason.decode(json) do
      %{
        strategy:       data["strategy"] || "우선순위 기반 구현",
        order:          data["order"] || [],
        estimated_cost: parse_float(data["estimated_cost"])
      }
    else
      _ ->
        %{strategy: text, order: [], estimated_cost: 0.0}
    end
  end

  defp parse_analysis_result(text) do
    with {:ok, json} <- extract_json(text),
         {:ok, data} <- Jason.decode(json) do
      verdict = case data["verdict"] do
        "apply"   -> :apply
        "defer"   -> :defer
        "discard" -> :discard
        _         -> :defer
      end
      %{
        verdict:    verdict,
        reason:     data["reason"] || "",
        confidence: parse_float(data["confidence"])
      }
    else
      _ ->
        %{verdict: :defer, reason: text, confidence: 0.5}
    end
  end

  defp parse_learning_result(text) do
    with {:ok, json} <- extract_json(text),
         {:ok, data} <- Jason.decode(json) do
      %{
        keyword_updates:      data["keyword_updates"] || [],
        threshold_adjustment: parse_float(data["threshold_adjustment"]),
        lessons:              data["lessons"] || []
      }
    else
      _ ->
        %{keyword_updates: [], threshold_adjustment: 0.0, lessons: [text]}
    end
  end

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
      line =~ ~r/easy/i  -> :easy
      line =~ ~r/hard/i  -> :hard
      true               -> :medium
    end
  end

  # JSON 블록 추출 (마크다운 코드블록 포함 처리)
  defp extract_json(text) do
    cond do
      # ```json ... ``` 패턴
      Regex.match?(~r/```json\s*(\{.+\})\s*```/s, text) ->
        [_, json] = Regex.run(~r/```json\s*(\{.+\})\s*```/s, text)
        {:ok, json}

      # ``` ... ``` 패턴
      Regex.match?(~r/```\s*(\{.+\})\s*```/s, text) ->
        [_, json] = Regex.run(~r/```\s*(\{.+\})\s*```/s, text)
        {:ok, json}

      # 직접 { ... } 패턴
      Regex.match?(~r/\{.+\}/s, text) ->
        [json] = Regex.run(~r/\{.+\}/s, text)
        {:ok, json}

      true ->
        {:error, :no_json}
    end
  end

  defp parse_float(nil), do: 0.0
  defp parse_float(v) when is_float(v), do: v
  defp parse_float(v) when is_integer(v), do: v * 1.0
  defp parse_float(v) when is_binary(v) do
    case Float.parse(v) do
      {f, _} -> f
      :error -> 0.0
    end
  end
  defp parse_float(_), do: 0.0
end
