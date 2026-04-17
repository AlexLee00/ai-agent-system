defmodule Darwin.V2.Reflexion do
  @moduledoc """
  Reflexion 패턴 (arXiv 2303.11366) — 다윈 연구 특화.

  파이프라인 실패, 낮은 평가 점수, 검증 거부 시 트리거.
  3가지 연구 특화 질문으로 LLM 회고 생성 → L2 :failure_lesson으로 저장.

  Kill switch: Application.get_env(:darwin, :reflexion_enabled, true)
    (예산 초과 시에만 비활성화 — 기본값 true)

  LLM: Darwin.V2.LLM.Selector.call_with_fallback("reflexion", ...) 경유.
  """

  require Logger

  # Kill switch — 예산 초과 시만 비활성화 (기본 true)
  @kill_switch_key :reflexion_enabled

  @doc """
  실패 컨텍스트에 대한 연구 특화 회고 생성 + L2 메모리(:failure_lesson) 저장.

  failure_context: %{
    trigger: :pipeline_failure | :low_evaluation | :verifier_rejection,
    phase:   String.t(),
    action:  term(),
    error:   term()
  }
  paper: %{title: String.t(), id: String.t(), ...} | nil
  """
  @spec reflect(map(), map() | nil) :: {:ok, map()} | {:error, term()}
  def reflect(failure_context, paper \\ nil) do
    unless Application.get_env(:darwin, @kill_switch_key, true) do
      Logger.info("[다윈V2 회고] Kill switch 비활성 — 회고 건너뜀")
      {:error, :reflexion_disabled}
    else
      trigger = failure_context[:trigger] || :unknown
      phase = failure_context[:phase] || "unknown"
      action = failure_context[:action] || %{}
      error = failure_context[:error] || "unknown"
      paper_title = if paper, do: paper[:title] || paper["title"] || "미상", else: "해당없음"
      paper_id = if paper, do: paper[:id] || paper["id"] || "", else: ""

      trigger_desc =
        case trigger do
          :pipeline_failure -> "파이프라인 실패"
          :low_evaluation -> "낮은 평가 점수"
          :verifier_rejection -> "검증기 거부"
          _ -> "알 수 없는 실패 (#{trigger})"
        end

      prompt = """
      다윈팀 연구 에이전트가 #{phase} 단계에서 다음 실패를 경험했습니다.

      실패 유형: #{trigger_desc}
      논문: #{paper_title}
      수행 작업: #{inspect(action)}
      오류 내용: #{inspect(error)}

      다음 3가지 질문에 각 2~3줄로 답하세요:
      1. 왜 이 논문이 구현에 실패했는가? (기술적 장벽, 리소스 부족, 전제조건 누락?)
      2. 어떤 대안적 접근이 가능한가? (다른 알고리즘, 더 단순한 베이스라인)
      3. 다음번 유사 논문 탐지 시 어떤 신호를 사전에 봐야 하는가?
      """

      reflection_text =
        case Darwin.V2.LLM.Selector.call_with_fallback("reflexion", prompt, max_tokens: 600) do
          {:ok, %{response: text}} when is_binary(text) and text != "" -> text
          {:ok, resp} -> inspect(resp)
          {:error, :budget_exceeded} ->
            Logger.warning("[다윈V2 회고] 예산 초과 — 반성 생략")
            "budget_exceeded: reflection_unavailable"
          {:error, reason} ->
            Logger.warning("[다윈V2 회고] LLM 호출 실패: #{inspect(reason)}")
            "llm_unavailable: reflection_skipped"
        end

      lesson = %{
        trigger: trigger,
        phase: phase,
        paper_title: paper_title,
        paper_id: paper_id,
        action: action,
        error: error,
        reflection: reflection_text,
        tags: extract_tags(reflection_text),
        created_at: DateTime.utc_now()
      }

      Darwin.V2.Memory.L1.store(:reflection, lesson, importance: 0.7)

      content = "[실패 교훈] trigger=#{trigger} phase=#{phase}\n논문: #{paper_title}\n반성: #{reflection_text}"
      tags = lesson.tags ++ [to_string(trigger), phase]

      Darwin.V2.Memory.L2.store("darwin", content, :failure_lesson,
        importance: 0.7,
        context: %{paper_id: paper_id, trigger: to_string(trigger)},
        tags: tags
      )

      {:ok, lesson}
    end
  rescue
    e ->
      Logger.error("[다윈V2 회고] 예외 발생: #{inspect(e)}")
      {:error, e}
  end

  @doc "논문 평가 실패 시 회고 생성 + 저장."
  @spec reflect_evaluation(map(), map()) :: {:ok, map()} | {:error, term()}
  def reflect_evaluation(paper, outcome) do
    title = paper[:title] || paper["title"] || "unknown"

    prompt = """
    다윈 연구팀이 다음 논문을 평가했으나 유용하지 않다고 판단했습니다.

    논문 제목: #{title}
    평가 결과: #{inspect(outcome)}
    점수: #{outcome[:score] || outcome["score"] || "N/A"}

    다음 3가지 질문에 각 2~3줄로 답하세요:
    1. 왜 이 논문이 우리 시스템에 적합하지 않다고 판단됐을 가능성이 높은가?
    2. 비슷한 논문을 사전에 필터링하려면 어떤 신호(키워드, 도메인, 방법론)를 봐야 하는가?
    3. 평가 기준을 어떻게 개선하면 유사 실수를 줄일 수 있는가?
    """

    reflect_and_store(:evaluation, title, prompt, outcome)
  end

  @doc "구현 실패 시 회고 생성 + 저장."
  @spec reflect_implementation(map(), map()) :: {:ok, map()} | {:error, term()}
  def reflect_implementation(paper, outcome) do
    title = paper[:title] || paper["title"] || "unknown"

    prompt = """
    다윈 에디슨이 다음 논문을 구현하려 했으나 실패했습니다.

    논문 제목: #{title}
    실패 원인: #{inspect(outcome[:error] || outcome["error"] || "unknown")}
    시도한 접근: #{inspect(outcome[:approach] || "N/A")}

    다음 3가지 질문에 각 2~3줄로 답하세요:
    1. 왜 이 구현이 실패했는가?
    2. 같은 논문 유형에서 더 나은 구현 전략은 무엇인가?
    3. 다음에는 어떤 다른 접근을 사용해야 하는가?
    """

    reflect_and_store(:implementation, title, prompt, outcome)
  end

  @doc "검증 실패 시 회고."
  @spec reflect_verification(map(), map()) :: {:ok, map()} | {:error, term()}
  def reflect_verification(paper, outcome) do
    title = paper[:title] || paper["title"] || "unknown"

    prompt = """
    다윈 검증 단계에서 논문 구현이 실패했습니다.

    논문 제목: #{title}
    검증 실패 원인: #{inspect(outcome[:error] || "unknown")}

    다음 3가지 질문에 각 2~3줄로 답하세요:
    1. 왜 검증이 실패했는가?
    2. 구현 단계에서 사전에 방지할 수 있었던 원인은 무엇인가?
    3. 검증 체계를 어떻게 강화해야 유사 실패를 줄일 수 있는가?
    """

    reflect_and_store(:verification, title, prompt, outcome)
  end

  # ---

  defp reflect_and_store(type, subject, prompt, outcome) do
    reflection_text =
      case Darwin.V2.LLM.Selector.call_with_fallback("reflexion", prompt, max_tokens: 600) do
        {:ok, %{response: text}} when is_binary(text) and text != "" -> text
        _ -> "reflection_unavailable"
      end

    entry = %{
      type:        type,
      subject:     subject,
      reflection:  reflection_text,
      outcome:     outcome,
      tags:        extract_tags(reflection_text),
      created_at:  DateTime.utc_now()
    }

    Darwin.V2.Memory.L1.store(:reflection, entry, importance: 0.8)

    Darwin.V2.Memory.L2.run(
      %{operation: :store, content: reflection_text, team: "darwin",
        importance: 0.8, tags: ["reflexion", to_string(type)]},
      %{}
    )

    {:ok, entry}
  rescue
    e ->
      Logger.error("[darwin/reflexion] 예외 발생: #{inspect(e)}")
      {:error, e}
  end

  defp extract_tags(text) when is_binary(text) do
    text
    |> String.split(~r/\s+/)
    |> Enum.filter(&(String.length(&1) > 4))
    |> Enum.uniq()
    |> Enum.take(5)
  end

  defp extract_tags(_), do: []
end
