defmodule Darwin.V2.Skill.ExperimentDesign do
  @moduledoc """
  ExperimentDesign — 논문 구현 검증을 위한 실험 설계.

  AI-Researcher mentee 패턴 기반:
    1. 논문에서 평가 지표 파악
    2. 기준 실험 설계 (단순 케이스)
    3. 엣지 케이스 실험 설계
    4. 스트레스 테스트 설계 (대용량 입력, 적대적 입력)
    5. 실험당 비용 추정

  LLM: Darwin.V2.LLM.Selector (agent "darwin.planner")
  원칙 체크: Darwin.V2.Principle.Loader.check/2
  """

  use Jido.Action,
    name: "darwin_v2_experiment_design",
    description: "Design experiments to validate paper implementations",
    schema: Zoi.object(%{
      paper:           Zoi.map() |> Zoi.required(),
      code_summary:    Zoi.default(Zoi.string(), ""),
      budget_usd:      Zoi.default(Zoi.float(), 5.0),
      include_stress:  Zoi.default(Zoi.boolean(), true)
    })

  require Logger

  @agent "darwin.planner"
  @log_prefix "[다윈V2 스킬:실험설계]"

  @impl Jido.Action
  def run(params, _ctx) do
    paper          = Map.fetch!(params, :paper)
    code_summary   = Map.get(params, :code_summary, "")
    budget_usd     = Map.get(params, :budget_usd, 5.0)
    include_stress = Map.get(params, :include_stress, true)

    Logger.info("#{@log_prefix} 시작 — title=#{Map.get(paper, :title, Map.get(paper, "title", "unknown"))}, budget=$#{budget_usd}")

    with :ok <- check_principle(paper),
         {:ok, result} <- design_experiments(paper, code_summary, budget_usd, include_stress) do
      Logger.info("#{@log_prefix} 완료 — total_cost=$#{result.total_cost_estimate_usd}, recommended=#{length(result.recommended_subset)}")
      {:ok, result}
    else
      {:error, reason} ->
        Logger.error("#{@log_prefix} 실패 — #{inspect(reason)}")
        {:error, reason}
    end
  end

  # --- 실험 설계 ---

  defp design_experiments(paper, code_summary, budget_usd, include_stress) do
    title    = Map.get(paper, :title,    Map.get(paper, "title",    ""))
    abstract = Map.get(paper, :abstract, Map.get(paper, "abstract", ""))

    stress_instruction =
      if include_stress,
        do: "Include stress tests.",
        else: "Skip stress tests (budget constrained)."

    prompt = """
    You are a research QA engineer designing experiments to validate a paper implementation.

    Paper: #{title}
    Abstract: #{abstract}
    Code summary: #{if code_summary == "", do: "(not provided)", else: String.slice(code_summary, 0, 500)}
    Budget: $#{budget_usd}
    #{stress_instruction}

    Design a comprehensive experiment suite with:

    1. baseline_experiments: Simple, small-scale tests to verify basic functionality
       - Use tiny datasets or synthetic inputs
       - Should pass if implementation is basically correct
       - Estimated cost: very low ($0.001-0.01 per experiment)

    2. edge_case_experiments: Tests for boundary conditions
       - Empty inputs, maximum sizes, unusual distributions
       - Single-element inputs, all-zeros, all-ones
       - Estimated cost: low ($0.01-0.1 per experiment)

    3. stress_tests: Large/adversarial inputs (if include_stress=true)
       - Maximum input sizes from paper
       - Adversarial inputs designed to break the algorithm
       - Estimated cost: medium-high ($0.1-1.0 per experiment)

    For each experiment provide:
    - name: descriptive name
    - description: what it tests
    - input_spec: what inputs to use
    - expected_outcome: what should happen
    - pass_criteria: concrete measurable criteria
    - cost_estimate_usd: estimated cost

    Respond in valid JSON:
    {
      "baseline_experiments": [
        {
          "name": "smoke_test",
          "description": "Basic forward pass with tiny input",
          "input_spec": "batch_size=2, seq_len=10, random data",
          "expected_outcome": "No errors, output shape matches expected",
          "pass_criteria": "output.shape == (2, num_classes) AND loss < 10.0",
          "cost_estimate_usd": 0.001
        }
      ],
      "edge_case_experiments": [...],
      "stress_tests": [...]
    }
    """

    case Darwin.V2.LLM.Selector.call_with_fallback(@agent, prompt, max_tokens: 2048) do
      {:ok, %{response: text}} ->
        case parse_json(text) do
          {:ok, parsed} ->
            baseline  = Map.get(parsed, "baseline_experiments", [])
            edge      = Map.get(parsed, "edge_case_experiments", [])
            stress    = if include_stress, do: Map.get(parsed, "stress_tests", []), else: []

            all_experiments = baseline ++ edge ++ stress
            total_cost      = sum_costs(all_experiments)
            recommended     = select_within_budget(baseline, edge, stress, budget_usd)

            result = %{
              baseline_experiments:    baseline,
              edge_case_experiments:   edge,
              stress_tests:            stress,
              total_cost_estimate_usd: Float.round(total_cost, 4),
              recommended_subset:      recommended
            }

            {:ok, result}

          {:error, _} ->
            Logger.warning("#{@log_prefix} JSON 파싱 실패 — 기본 실험 세트 사용")
            {:ok, default_experiment_suite(title)}
        end

      {:error, reason} ->
        {:error, {:design_llm_failed, reason}}
    end
  end

  # --- 예산 내 추천 실험 선택 ---

  defp select_within_budget(baseline, edge, stress, budget_usd) do
    # 우선순위: baseline > edge > stress
    # 예산 내에서 최대한 포함
    all_ordered = baseline ++ edge ++ stress

    {selected, _remaining} =
      Enum.reduce(all_ordered, {[], budget_usd}, fn exp, {acc, remaining} ->
        cost = get_cost(exp)
        if cost <= remaining do
          {acc ++ [exp], remaining - cost}
        else
          {acc, remaining}
        end
      end)

    # 최소한 baseline은 모두 포함 (비용 무관)
    if length(selected) == 0 do
      baseline
    else
      selected
    end
  end

  defp sum_costs(experiments) do
    Enum.reduce(experiments, 0.0, fn exp, acc -> acc + get_cost(exp) end)
  end

  defp get_cost(exp) when is_map(exp) do
    v = Map.get(exp, "cost_estimate_usd", Map.get(exp, :cost_estimate_usd, 0.0))
    to_float(v)
  end

  defp default_experiment_suite(title) do
    %{
      baseline_experiments: [
        %{
          "name"             => "smoke_test",
          "description"      => "#{title} 기본 실행 테스트",
          "input_spec"       => "최소 크기 입력 (batch_size=1)",
          "expected_outcome" => "오류 없이 출력 생성",
          "pass_criteria"    => "예외 없이 완료",
          "cost_estimate_usd" => 0.001
        }
      ],
      edge_case_experiments: [
        %{
          "name"             => "empty_input",
          "description"      => "빈 입력 처리",
          "input_spec"       => "빈 텐서/리스트",
          "expected_outcome" => "적절한 오류 처리 또는 빈 출력",
          "pass_criteria"    => "크래시 없음",
          "cost_estimate_usd" => 0.001
        }
      ],
      stress_tests: [],
      total_cost_estimate_usd: 0.002,
      recommended_subset: [
        %{"name" => "smoke_test", "description" => "기본 실행 테스트"}
      ]
    }
  end

  # --- 헬퍼 ---

  defp check_principle(paper) do
    case Darwin.V2.Principle.Loader.check(:experiment_design, %{paper: paper}) do
      :ok              -> :ok
      {:ok, _}         -> :ok
      {:error, reason} -> {:error, {:principle_violation, reason}}
    end
  rescue
    _ -> :ok
  end

  defp to_float(v) when is_float(v),   do: v
  defp to_float(v) when is_integer(v), do: v * 1.0
  defp to_float(v) when is_binary(v) do
    case Float.parse(v) do
      {f, _} -> f
      :error -> 0.0
    end
  end
  defp to_float(_), do: 0.0

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
