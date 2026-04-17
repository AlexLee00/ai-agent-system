defmodule Darwin.V2.Skill.ResourceAnalyst do
  @moduledoc """
  ResourceAnalyst — 논문을 원자적 구성요소로 분해하고 구현 자원을 추정.

  AI-Researcher (HKUDS, NeurIPS 2025) 패턴 기반:
    Step 1: 논문 → 원자적 구성요소 분해 (알고리즘, 파이프라인, 지표, 의존성)
    Step 2: 각 구성요소별 코드 스켈레톤 생성 (수식 ↔ 코드 양방향 매핑)
    Step 3: 자원 추정 (GPU, 비용, 시간, 복잡도)

  LLM: Darwin.V2.LLM.Selector (agent "darwin.planner")
  원칙 체크: Darwin.V2.Principle.Loader.check/2
  """

  use Jido.Action,
    name: "darwin_v2_resource_analyst",
    description: "Decompose paper into atomic components and estimate implementation resources",
    schema: Zoi.object(%{
      paper: Zoi.map() |> Zoi.required(),
      max_cost_usd: Zoi.default(Zoi.float(), 2.0)
    })

  require Logger

  @agent "darwin.planner"
  @log_prefix "[다윈V2 스킬:자원분석]"

  @impl Jido.Action
  def run(params, _ctx) do
    paper = Map.get(params, :paper, %{})
    max_cost_usd = Map.get(params, :max_cost_usd, 2.0)

    Logger.info("#{@log_prefix} 시작 — title=#{Map.get(paper, :title, Map.get(paper, "title", "unknown"))}")

    with :ok <- check_principle(paper),
         {:ok, components} <- step1_decompose(paper),
         {:ok, skeletons, formula_map} <- step2_generate_skeletons(paper, components),
         {:ok, estimate} <- step3_estimate_resources(paper, components, max_cost_usd) do

      plan = build_implementation_plan(components, skeletons)

      result = %{
        atomic_components: components,
        code_skeletons: skeletons,
        formula_code_map: formula_map,
        resource_estimate: estimate,
        implementation_plan: plan
      }

      Logger.info("#{@log_prefix} 완료 — complexity=#{estimate.complexity}, time=#{estimate.time_estimate_hours}h")
      {:ok, result}
    else
      {:error, reason} ->
        Logger.error("#{@log_prefix} 실패 — #{inspect(reason)}")
        {:error, reason}
    end
  end

  # --- Step 1: 원자적 구성요소 분해 ---

  defp step1_decompose(paper) do
    title    = Map.get(paper, :title,    Map.get(paper, "title",    ""))
    abstract = Map.get(paper, :abstract, Map.get(paper, "abstract", ""))

    prompt = """
    You are a research engineer. Decompose this paper into atomic implementable components.

    Paper Title: #{title}
    Abstract: #{abstract}

    Extract EXACTLY these four categories:
    1. core_algorithm: Core mathematical algorithms (list math formulas with equation numbers if mentioned)
    2. data_pipeline: Data loading, preprocessing, augmentation steps
    3. evaluation_metrics: Metrics used to evaluate the method
    4. dependencies: Required libraries, frameworks, external tools

    Respond in valid JSON:
    {
      "core_algorithm": ["formula/step description", ...],
      "data_pipeline": ["step description", ...],
      "evaluation_metrics": ["metric description", ...],
      "dependencies": ["library/framework name", ...]
    }
    """

    case Darwin.V2.LLM.Selector.call_with_fallback(@agent, prompt, max_tokens: 1024) do
      {:ok, %{response: text}} ->
        case parse_json(text) do
          {:ok, parsed} ->
            components = %{
              core_algorithm:     Map.get(parsed, "core_algorithm", []),
              data_pipeline:      Map.get(parsed, "data_pipeline", []),
              evaluation_metrics: Map.get(parsed, "evaluation_metrics", []),
              dependencies:       Map.get(parsed, "dependencies", [])
            }
            {:ok, components}

          {:error, _} ->
            Logger.warning("#{@log_prefix} Step1 JSON 파싱 실패 — fallback 사용")
            {:ok, fallback_components(abstract)}
        end

      {:error, reason} ->
        {:error, {:step1_failed, reason}}
    end
  end

  # --- Step 2: 코드 스켈레톤 생성 ---

  defp step2_generate_skeletons(paper, components) do
    title    = Map.get(paper, :title,    Map.get(paper, "title",    ""))
    abstract = Map.get(paper, :abstract, Map.get(paper, "abstract", ""))

    prompt = """
    You are a research engineer. Generate code skeletons and formula-to-code mappings.

    Paper: #{title}
    Abstract: #{abstract}
    Core Algorithm Components: #{inspect(components.core_algorithm)}

    Generate:
    1. code_skeletons: Python pseudocode skeleton for each component
       Keys: "algorithm", "data_pipeline", "evaluation", "main"
    2. formula_code_map: Map each formula/equation to pseudocode
       Keys: "equation_1", "equation_2", etc. (or descriptive names)

    Bidirectional mapping principle: every formula should have a code analog,
    every non-trivial code block should reference its mathematical basis.

    Respond in valid JSON:
    {
      "code_skeletons": {
        "algorithm": "# Python pseudocode\\ndef core_algorithm(...):\\n    ...",
        "data_pipeline": "...",
        "evaluation": "...",
        "main": "..."
      },
      "formula_code_map": {
        "equation_1": "# pseudocode for this formula",
        "equation_2": "..."
      }
    }
    """

    case Darwin.V2.LLM.Selector.call_with_fallback(@agent, prompt, max_tokens: 2048) do
      {:ok, %{response: text}} ->
        case parse_json(text) do
          {:ok, parsed} ->
            skeletons    = Map.get(parsed, "code_skeletons", %{})
            formula_map  = Map.get(parsed, "formula_code_map", %{})
            {:ok, skeletons, formula_map}

          {:error, _} ->
            Logger.warning("#{@log_prefix} Step2 JSON 파싱 실패 — 빈 스켈레톤 사용")
            {:ok, %{"algorithm" => "# TODO: implement core algorithm"}, %{}}
        end

      {:error, reason} ->
        {:error, {:step2_failed, reason}}
    end
  end

  # --- Step 3: 자원 추정 ---

  defp step3_estimate_resources(paper, components, max_cost_usd) do
    title    = Map.get(paper, :title,    Map.get(paper, "title",    ""))
    abstract = Map.get(paper, :abstract, Map.get(paper, "abstract", ""))

    prompt = """
    You are a research infrastructure engineer. Estimate implementation resources.

    Paper: #{title}
    Abstract: #{abstract}
    Dependencies: #{inspect(components.dependencies)}
    Algorithm complexity: #{length(components.core_algorithm)} core formulas/steps

    Estimate:
    1. gpu_required: Does implementation require GPU? (true/false)
       Look for: "neural network", "deep learning", "CUDA", "GPU", "training"
    2. llm_calls_estimate: How many LLM calls to implement? (integer, based on complexity)
    3. complexity: "simple" (1-3 formulas, known methods) / "medium" (4-8, some novel) / "complex" (9+, highly novel)
    4. time_estimate_hours: simple=1, medium=4, complex=8

    Budget note: max allowed LLM cost is $#{max_cost_usd}

    Respond in valid JSON:
    {
      "gpu_required": true,
      "llm_calls_estimate": 15,
      "complexity": "medium",
      "time_estimate_hours": 4
    }
    """

    case Darwin.V2.LLM.Selector.call_with_fallback(@agent, prompt, max_tokens: 512) do
      {:ok, %{response: text}} ->
        case parse_json(text) do
          {:ok, parsed} ->
            llm_calls   = Map.get(parsed, "llm_calls_estimate", 10)
            complexity  = parse_complexity(Map.get(parsed, "complexity", "medium"))
            cost_est    = estimate_cost_usd(llm_calls, complexity)

            estimate = %{
              gpu_required:        Map.get(parsed, "gpu_required", false),
              cost_estimate_usd:   Float.round(cost_est, 4),
              time_estimate_hours: complexity_to_hours(complexity),
              complexity:          complexity
            }

            {:ok, estimate}

          {:error, _} ->
            Logger.warning("#{@log_prefix} Step3 JSON 파싱 실패 — 기본 추정 사용")
            {:ok, default_estimate()}
        end

      {:error, reason} ->
        {:error, {:step3_failed, reason}}
    end
  end

  # --- 원칙 체크 ---

  defp check_principle(paper) do
    case Darwin.V2.Principle.Loader.check(:resource_analyst, %{paper: paper}) do
      :ok                 -> :ok
      {:ok, _}            -> :ok
      {:error, reason}    -> {:error, {:principle_violation, reason}}
    end
  rescue
    _ -> :ok
  end

  # --- 구현 계획 빌드 ---

  defp build_implementation_plan(components, skeletons) do
    base = [
      "1. 환경 설정: #{Enum.join(components.dependencies, ", ")}",
      "2. 데이터 파이프라인 구현",
      "3. 핵심 알고리즘 구현 (#{length(components.core_algorithm)}개 구성요소)"
    ]

    eval_step =
      if length(components.evaluation_metrics) > 0,
        do: ["4. 평가 지표 구현: #{Enum.join(components.evaluation_metrics, ", ")}"],
        else: ["4. 평가 지표 구현"]

    integration_step = ["5. 통합 테스트 및 검증"]

    skeleton_step =
      if map_size(skeletons) > 0,
        do: ["6. 스켈레톤 기반 코드 완성 (#{map_size(skeletons)}개 모듈)"],
        else: []

    base ++ eval_step ++ integration_step ++ skeleton_step
  end

  # --- 헬퍼 ---

  defp fallback_components(abstract) do
    has_nn = abstract =~ ~r/neural|deep learning|transformer|attention/i

    %{
      core_algorithm:     ["주 알고리즘 (상세 분석 필요)"],
      data_pipeline:      ["데이터 로딩 및 전처리"],
      evaluation_metrics: ["정확도", "손실"],
      dependencies:       if(has_nn, do: ["torch", "numpy"], else: ["numpy", "scikit-learn"])
    }
  end

  defp parse_complexity("simple"),  do: :simple
  defp parse_complexity("medium"),  do: :medium
  defp parse_complexity("complex"), do: :complex
  defp parse_complexity(_),         do: :medium

  defp complexity_to_hours(:simple),  do: 1
  defp complexity_to_hours(:medium),  do: 4
  defp complexity_to_hours(:complex), do: 8

  defp estimate_cost_usd(llm_calls, complexity) do
    base_per_call =
      case complexity do
        :simple  -> 0.001
        :medium  -> 0.005
        :complex -> 0.015
      end

    llm_calls * base_per_call
  end

  defp default_estimate do
    %{
      gpu_required:        false,
      cost_estimate_usd:   0.05,
      time_estimate_hours: 4,
      complexity:          :medium
    }
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
        # JSON 블록만 추출 시도
        case Regex.run(~r/\{[\s\S]*\}/m, cleaned) do
          [json_str | _] ->
            case Jason.decode(json_str) do
              {:ok, parsed} -> {:ok, parsed}
              error         -> error
            end
          nil -> {:error, :no_json_found}
        end
    end
  end
  defp parse_json(_), do: {:error, :not_a_string}
end
