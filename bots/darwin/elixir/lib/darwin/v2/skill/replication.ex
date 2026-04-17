defmodule Darwin.V2.Skill.Replication do
  @moduledoc """
  Replication — 논문 구현이 보고된 결과를 실제로 재현하는지 검증.

  검증 단계:
    1. 논문 abstract/conclusion에서 주장된 결과 추출
    2. 구현된 코드를 참조 입력으로 실행
    3. 출력을 주장된 결과와 비교
    4. reproduction_score (0-1) 계산

  허용 오차:
    - 수치 지표: 10%
    - 범주형: 정확히 일치

  LLM: Darwin.V2.LLM.Selector (agent "darwin.planner")
  원칙 체크: Darwin.V2.Principle.Loader.check/2
  """

  use Jido.Action,
    name: "darwin_v2_replication",
    description: "Verify paper implementation reproduces reported results",
    schema: Zoi.object(%{
      paper:           Zoi.map() |> Zoi.required(),
      code_path:       Zoi.optional(Zoi.string()),
      actual_results:  Zoi.default(Zoi.map(), %{}),
      run_code:        Zoi.default(Zoi.boolean(), false)
    })

  require Logger

  @agent "darwin.planner"
  @log_prefix "[다윈V2 스킬:재현검증]"
  @numeric_tolerance 0.10

  @impl Jido.Action
  def run(params, _ctx) do
    paper          = Map.fetch!(params, :paper)
    actual_results = Map.get(params, :actual_results, %{})
    code_path      = Map.get(params, :code_path)
    run_code       = Map.get(params, :run_code, false)

    Logger.info("#{@log_prefix} 시작 — title=#{Map.get(paper, :title, Map.get(paper, "title", "unknown"))}")

    with :ok <- check_principle(paper),
         {:ok, claimed} <- extract_claimed_results(paper),
         {:ok, actual}  <- resolve_actual_results(actual_results, code_path, run_code, claimed) do

      comparison   = compare_results(claimed, actual)
      score        = calculate_reproduction_score(comparison)
      verdict      = determine_verdict(score)
      notes        = generate_notes(comparison, claimed, actual)

      result = %{
        claimed_results:    claimed,
        actual_results:     actual,
        reproduction_score: Float.round(score, 3),
        delta:              comparison,
        verdict:            verdict,
        notes:              notes
      }

      Logger.info("#{@log_prefix} 완료 — verdict=#{verdict}, score=#{Float.round(score, 3)}")
      {:ok, result}
    else
      {:error, reason} ->
        Logger.error("#{@log_prefix} 실패 — #{inspect(reason)}")
        {:error, reason}
    end
  end

  # --- Step 1: 주장된 결과 추출 ---

  defp extract_claimed_results(paper) do
    title    = Map.get(paper, :title,    Map.get(paper, "title",    ""))
    abstract = Map.get(paper, :abstract, Map.get(paper, "abstract", ""))

    prompt = """
    You are a research analyst. Extract all claimed quantitative and qualitative results from this paper.

    Paper: #{title}
    Abstract: #{abstract}

    Extract EVERY specific result claim:
    - Accuracy percentages, F1 scores, BLEU scores, etc.
    - Speedup factors, memory reductions
    - Qualitative claims (e.g., "outperforms baseline", "state-of-the-art")
    - Dataset-specific results

    For each result, identify:
    - metric: name of the metric
    - value: the claimed value (number or string)
    - type: "numeric" or "categorical"
    - dataset: which dataset (if mentioned)
    - comparison: what it's compared against (if applicable)

    Respond in valid JSON:
    {
      "results": [
        {
          "metric": "accuracy",
          "value": 92.5,
          "type": "numeric",
          "dataset": "ImageNet",
          "comparison": "ResNet-50 baseline (89.1%)"
        },
        ...
      ]
    }
    """

    case Darwin.V2.LLM.Selector.call_with_fallback(@agent, prompt, max_tokens: 1024) do
      {:ok, %{response: text}} ->
        case parse_json(text) do
          {:ok, %{"results" => results}} when is_list(results) ->
            {:ok, results}

          {:ok, _} ->
            {:ok, []}

          {:error, _} ->
            Logger.warning("#{@log_prefix} 결과 추출 JSON 파싱 실패")
            {:ok, [%{"metric" => "general_performance", "value" => "not_extracted", "type" => "categorical"}]}
        end

      {:error, reason} ->
        {:error, {:extract_claimed_failed, reason}}
    end
  end

  # --- Step 2: 실제 결과 해결 ---

  defp resolve_actual_results(provided_actual, code_path, run_code, claimed) do
    cond do
      map_size(provided_actual) > 0 ->
        # 이미 실제 결과가 제공됨
        {:ok, provided_actual}

      run_code and is_binary(code_path) and File.exists?(code_path) ->
        # 코드 실행 (보안 주의: 샌드박스 환경 필요)
        run_code_safely(code_path, claimed)

      true ->
        # 실제 결과 없음 — 빈 맵 반환 (재현 불가 상태)
        Logger.warning("#{@log_prefix} 실제 결과 없음 — 재현 불가")
        {:ok, %{}}
    end
  end

  defp run_code_safely(code_path, _claimed) do
    Logger.info("#{@log_prefix} 코드 실행 시도 — #{code_path}")

    # 실제 코드 실행은 샌드박스 환경(Edison)에서만 허용
    # 여기서는 코드 실행 결과를 반환할 수 없으므로 빈 결과 반환
    Logger.warning("#{@log_prefix} 직접 코드 실행 미지원 — Edison 에이전트를 통해 실행하세요")
    {:ok, %{_note: "code_execution_delegated_to_edison", code_path: code_path}}
  end

  # --- Step 3: 결과 비교 ---

  defp compare_results(_claimed, actual) when map_size(actual) == 0 do
    %{_note: "no_actual_results_provided"}
  end

  defp compare_results(claimed, actual) do
    Enum.reduce(claimed, %{}, fn claim, acc ->
      metric = Map.get(claim, "metric", Map.get(claim, :metric, "unknown"))
      claimed_val = Map.get(claim, "value", Map.get(claim, :value))
      result_type = Map.get(claim, "type", Map.get(claim, :type, "categorical"))

      actual_val = Map.get(actual, metric) || Map.get(actual, String.to_atom(metric))

      comparison = compare_single(claimed_val, actual_val, result_type)
      Map.put(acc, metric, comparison)
    end)
  end

  defp compare_single(claimed, nil, _type) do
    {claimed, nil, false}
  end

  defp compare_single(claimed, actual, "numeric") do
    with {c_num, _} <- parse_number(claimed),
         {a_num, _} <- parse_number(actual) do
      within_tolerance = abs(c_num - a_num) / max(abs(c_num), 1.0e-10) <= @numeric_tolerance
      {claimed, actual, within_tolerance}
    else
      _ -> {claimed, actual, false}
    end
  end

  defp compare_single(claimed, actual, "categorical") do
    within_tolerance = to_string(claimed) == to_string(actual)
    {claimed, actual, within_tolerance}
  end

  defp compare_single(claimed, actual, _) do
    compare_single(claimed, actual, "categorical")
  end

  # --- Step 4: 재현 점수 계산 ---

  defp calculate_reproduction_score(comparison) when map_size(comparison) == 0 do
    0.0
  end

  defp calculate_reproduction_score(comparison) do
    entries = Map.to_list(comparison) |> Enum.reject(fn {k, _} -> k == :_note end)

    if length(entries) == 0 do
      0.0
    else
      matched =
        Enum.count(entries, fn {_metric, {_c, _a, within}} ->
          within == true
        end)

      matched / length(entries)
    end
  end

  defp determine_verdict(score) when score >= 0.8, do: :reproduced
  defp determine_verdict(score) when score >= 0.4, do: :partial
  defp determine_verdict(_score),                  do: :failed

  defp generate_notes(comparison, claimed, actual) do
    cond do
      map_size(actual) == 0 ->
        "실제 결과가 제공되지 않았습니다. 재현 검증을 위해 코드를 실행하거나 actual_results를 직접 제공하세요."

      map_size(comparison) == 0 ->
        "비교할 수 있는 결과가 없습니다."

      true ->
        failed_metrics =
          comparison
          |> Enum.reject(fn {k, _} -> k == :_note end)
          |> Enum.filter(fn {_k, {_c, _a, ok}} -> ok == false end)
          |> Enum.map(fn {metric, {claimed_v, actual_v, _}} ->
            "#{metric}: 주장=#{inspect(claimed_v)}, 실제=#{inspect(actual_v)}"
          end)

        total = length(claimed)
        failed = length(failed_metrics)

        base = "#{total}개 지표 중 #{total - failed}개 재현 성공."

        if failed > 0 do
          base <> " 실패 지표: " <> Enum.join(failed_metrics, "; ")
        else
          base <> " 모든 지표 재현 성공."
        end
    end
  end

  # --- 헬퍼 ---

  defp check_principle(paper) do
    case Darwin.V2.Principle.Loader.check(:replication, %{paper: paper}) do
      {:approved, _} -> :ok
      {:blocked, reasons} -> {:error, {:principle_violation, reasons}}
    end
  rescue
    _ -> :ok
  end

  defp parse_number(v) when is_float(v),   do: {v, ""}
  defp parse_number(v) when is_integer(v), do: {v * 1.0, ""}
  defp parse_number(v) when is_binary(v) do
    # 퍼센트 처리: "92.5%" → 92.5
    cleaned = String.replace(v, "%", "") |> String.trim()
    case Float.parse(cleaned) do
      {f, rest} -> {f, rest}
      :error    -> :error
    end
  end
  defp parse_number(_), do: :error

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
