defmodule Darwin.V2.Skill.PaperSynthesis do
  @moduledoc """
  PaperSynthesis — 여러 관련 논문을 통합 구현 전략으로 합성.

  여러 논문에서:
    - 공통 주제 및 방법론 파악
    - 보완적 기법 발견
    - 충돌/모순 식별
    - 각 논문의 장점을 결합한 통합 접근법 생성

  LLM: Darwin.V2.LLM.Selector (agent "darwin.planner")
  원칙 체크: Darwin.V2.Principle.Loader.check/2
  """

  use Jido.Action,
    name: "darwin_v2_paper_synthesis",
    description: "Synthesize multiple related papers into unified implementation strategy",
    schema: Zoi.object(%{
      papers:          Zoi.list() |> Zoi.required(),
      synthesis_goal:  Zoi.string() |> Zoi.required()
    })

  require Logger

  @agent "darwin.planner"
  @log_prefix "[다윈V2 스킬:논문합성]"

  @impl Jido.Action
  def run(params, _ctx) do
    papers         = Map.fetch!(params, :papers)
    synthesis_goal = Map.fetch!(params, :synthesis_goal)

    Logger.info("#{@log_prefix} 시작 — papers=#{length(papers)}, goal=#{String.slice(synthesis_goal, 0, 80)}")

    if length(papers) == 0 do
      {:error, :no_papers_provided}
    else
      with :ok <- check_principle(papers, synthesis_goal),
           {:ok, result} <- synthesize(papers, synthesis_goal) do
        Logger.info("#{@log_prefix} 완료 — themes=#{length(result.common_themes)}, conflicts=#{length(result.conflicts)}")
        {:ok, result}
      else
        {:error, reason} ->
          Logger.error("#{@log_prefix} 실패 — #{inspect(reason)}")
          {:error, reason}
      end
    end
  end

  # --- 합성 처리 ---

  defp synthesize(papers, synthesis_goal) do
    paper_summaries = format_papers(papers)

    prompt = """
    You are a senior research scientist synthesizing multiple papers.

    Synthesis Goal: #{synthesis_goal}

    Papers to synthesize:
    #{paper_summaries}

    Analyze these papers and provide:

    1. common_themes: Methodologies, principles, or approaches shared across papers
    2. unique_contributions: What each paper uniquely contributes
       (key: paper title, value: list of unique contributions)
    3. conflicts: Areas where papers disagree or use incompatible approaches
    4. synthesis: A unified approach that combines the best elements of all papers
       (2-4 paragraphs describing the integrated methodology)
    5. recommended_papers: Papers ordered by relevance to the synthesis goal
       (most relevant first, list of titles)

    Respond in valid JSON:
    {
      "common_themes": [
        "Theme description",
        ...
      ],
      "unique_contributions": {
        "Paper Title 1": ["contribution 1", "contribution 2"],
        "Paper Title 2": ["contribution 1"]
      },
      "conflicts": [
        "Conflict description",
        ...
      ],
      "synthesis": "Unified approach: ...",
      "recommended_papers": ["Most relevant paper title", ...]
    }
    """

    case Darwin.V2.LLM.Selector.call_with_fallback(@agent, prompt, max_tokens: 2048) do
      {:ok, %{response: text}} ->
        case parse_json(text) do
          {:ok, parsed} ->
            result = %{
              common_themes:        Map.get(parsed, "common_themes", []),
              unique_contributions: Map.get(parsed, "unique_contributions", %{}),
              conflicts:            Map.get(parsed, "conflicts", []),
              synthesis:            Map.get(parsed, "synthesis", ""),
              recommended_papers:   Map.get(parsed, "recommended_papers", extract_titles(papers))
            }
            {:ok, result}

          {:error, _} ->
            Logger.warning("#{@log_prefix} JSON 파싱 실패 — 텍스트 기반 fallback 사용")
            {:ok, text_fallback_result(papers, text)}
        end

      {:error, reason} ->
        {:error, {:synthesis_llm_failed, reason}}
    end
  end

  # --- 헬퍼 ---

  defp format_papers(papers) do
    papers
    |> Enum.with_index(1)
    |> Enum.map(fn {paper, idx} ->
      title    = Map.get(paper, :title,    Map.get(paper, "title",    "Unknown Title"))
      abstract = Map.get(paper, :abstract, Map.get(paper, "abstract", ""))
      url      = Map.get(paper, :url,      Map.get(paper, "url",      ""))
      score    = Map.get(paper, :score,    Map.get(paper, "score",    nil))

      score_str = if score, do: " (relevance: #{score})", else: ""

      """
      [Paper #{idx}] #{title}#{score_str}
      URL: #{url}
      Abstract: #{String.slice(abstract, 0, 600)}
      """
    end)
    |> Enum.join("\n---\n")
  end

  defp extract_titles(papers) do
    Enum.map(papers, fn p ->
      Map.get(p, :title, Map.get(p, "title", "Unknown"))
    end)
  end

  defp text_fallback_result(papers, raw_text) do
    titles = extract_titles(papers)

    %{
      common_themes:        ["분석 완료 (상세 내용 아래 synthesis 참조)"],
      unique_contributions: Map.new(titles, fn t -> {t, ["기여 분석 필요"]} end),
      conflicts:            [],
      synthesis:            raw_text,
      recommended_papers:   titles
    }
  end

  defp check_principle(papers, goal) do
    case Darwin.V2.Principle.Loader.check(:paper_synthesis, %{papers: papers, goal: goal}) do
      {:approved, _} -> :ok
      {:blocked, reasons} -> {:error, {:principle_violation, reasons}}
    end
  rescue
    _ -> :ok
  end

  defp parse_json(text) when is_binary(text) do
    cleaned =
      text
      |> String.replace(~r/```json\s*/i, "")
      |> String.replace(~r/```\s*/, "")
      |> String.trim()

    case Jason.decode(cleaned) do
      {:ok, parsed} -> {:ok, parsed}
      {:error, _}   ->
        case Regex.run(~r/\{[\s\S]*\}/m, cleaned) do
          [json_str | _] -> Jason.decode(json_str)
          nil            -> {:error, :no_json_found}
        end
    end
  end
  defp parse_json(_), do: {:error, :not_a_string}
end
