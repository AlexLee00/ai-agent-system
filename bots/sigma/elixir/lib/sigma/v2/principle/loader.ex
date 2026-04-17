defmodule Sigma.V2.Principle.Loader do
  @moduledoc """
  Constitutional 원칙 로더 — sigma_principles.yaml 파싱 + 자기평가.
  Commander가 Directive 실행 전 self_critique/2 호출.

  2단계 평가:
  1. Keyword 매칭 (항상 실행, 빠른 1차 필터)
  2. LLM 의미 기반 판정 (SIGMA_PRINCIPLE_SEMANTIC_CHECK_ENABLED=true 시만 실행)
  """

  require Logger

  @principles_path Path.join(
    :code.priv_dir(:team_jay) |> to_string(),
    "../config/sigma_principles.yaml"
  )

  @doc "sigma_principles.yaml 로드 + 파싱."
  @spec load() :: {:ok, map()} | {:error, term()}
  def load do
    path = @principles_path

    if File.exists?(path) do
      case YamlElixir.read_from_file(path) do
        {:ok, parsed} -> {:ok, parsed}
        {:error, reason} -> {:error, "yaml parse error: #{inspect(reason)}"}
      end
    else
      {:error, "principles file not found: #{path}"}
    end
  end

  @doc """
  Directive 실행 전 자기평가.
  1단계: keyword 매칭 (기존 빠른 필터)
  2단계: LLM 의미 기반 판정 (Kill Switch: SIGMA_PRINCIPLE_SEMANTIC_CHECK_ENABLED)
  """
  @spec self_critique(map(), map() | nil) ::
          {:approved, []} | {:blocked, [String.t()]}
  def self_critique(directive, principles \\ nil) do
    resolved_principles =
      case principles do
        nil ->
          case load() do
            {:ok, p} -> p
            _ -> %{}
          end

        p ->
          p
      end

    # 1단계: keyword 매칭 (빠른 1차 필터)
    keyword_blocked = check_absolute_prohibitions(directive, resolved_principles)

    cond do
      keyword_blocked != [] ->
        {:blocked, keyword_blocked}

      # 2단계: 의미 기반 LLM 판정 (Kill Switch)
      System.get_env("SIGMA_PRINCIPLE_SEMANTIC_CHECK_ENABLED") == "true" ->
        semantic_check(directive, resolved_principles)

      true ->
        {:approved, []}
    end
  end

  # -------------------------------------------------------------------
  # Private — keyword matching (1단계)
  # -------------------------------------------------------------------

  defp check_absolute_prohibitions(directive, principles) do
    tiers = principles["tiers"] || principles[:tiers] || []
    tier3 = Enum.find(tiers, &((&1["tier"] || &1[:tier]) == 3)) || %{}
    prohibitions = tier3["prohibitions"] || tier3[:prohibitions] || []

    action = directive[:action] || directive["action"] || ""
    team = directive[:team] || directive["team"] || ""

    prohibitions
    |> Enum.filter(fn rule ->
      rule_action = rule["action"] || rule[:action] || ""
      rule_team = rule["team"] || rule[:team] || ""

      matches_action?(action, rule_action) and
        (rule_team == "" or rule_team == team or rule_team == "*")
    end)
    |> Enum.map(fn rule ->
      principle = rule["principle"] || rule[:principle] || "unknown"
      description = rule["description"] || rule[:description] || ""
      "#{principle}: #{description}"
    end)
  end

  defp matches_action?(_action, ""), do: false
  defp matches_action?(action, rule_action), do: String.contains?(action, rule_action)

  # -------------------------------------------------------------------
  # Private — LLM semantic check (2단계, Kill Switch 보호)
  # -------------------------------------------------------------------

  defp semantic_check(directive, principles) do
    action = directive[:action] || directive["action"] || ""
    team = directive[:team] || directive["team"] || ""
    tier3_rules = extract_tier3_rules(principles)

    prompt = """
    다음 시그마 지시(directive)가 Tier 3 절대 금지 원칙을 위반하는지 판정하세요.

    [지시]
    team: #{team}
    action: #{inspect(action)}

    [Tier 3 원칙 목록]
    #{Enum.map_join(tier3_rules, "\n", fn r -> "- #{r["principle"] || "?"}: #{r["description"] || ""}" end)}

    응답 형식: 정확히 한 줄
    - 위반 없음: [APPROVED]
    - 위반 있음: [BLOCKED] <위반한 원칙 번호>
    """

    case Sigma.V2.LLM.Selector.call_with_fallback(
           :"principle.critique",
           prompt,
           max_tokens: 50,
           urgency: :high,
           task_type: :structured_reasoning
         ) do
      {:ok, %{response: text}} ->
        if String.contains?(text, "[BLOCKED]") do
          violation = extract_violation(text, tier3_rules)
          {:blocked, [violation]}
        else
          {:approved, []}
        end

      {:error, _} ->
        # LLM 실패 시 안전하게 통과 (keyword 매칭으로 이미 1차 필터링됨)
        Logger.warning("[sigma/principle] semantic check LLM 실패 — keyword-only로 통과")
        {:approved, []}
    end
  end

  defp extract_tier3_rules(principles) do
    tiers = principles["tiers"] || principles[:tiers] || []
    tier3 = Enum.find(tiers, &((&1["tier"] || &1[:tier]) == 3)) || %{}
    tier3["prohibitions"] || tier3[:prohibitions] || []
  end

  defp extract_violation(text, _tier3_rules) do
    # "[BLOCKED] P-XXX" 형식에서 원칙 번호 추출
    case Regex.run(~r/\[BLOCKED\]\s*(.+)/, String.trim(text)) do
      [_, violation] -> String.trim(violation)
      _ -> "semantic: #{String.slice(text, 0, 80)}"
    end
  end
end
