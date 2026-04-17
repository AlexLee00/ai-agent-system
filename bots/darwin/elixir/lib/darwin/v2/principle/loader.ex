defmodule Darwin.V2.Principle.Loader do
  @moduledoc """
  Constitutional 원칙 로더 — darwin_principles.yaml 파싱 + 자기평가.
  Commander가 액션 실행 전 check/2 호출.

  2단계 평가:
  1. Keyword 매칭 (항상 실행, 빠른 1차 필터)
  2. LLM 의미 기반 판정 (DARWIN_PRINCIPLE_SEMANTIC_CHECK_ENABLED=true 시만 실행)

  YAML 경로: priv/config/darwin_principles.yaml
  YAML 없을 경우 하드코딩된 Tier 3 금지 규칙으로 폴백.

  Darwin Tier 3 금지 (hardcoded fallback):
    표절_금지: 다른 구현을 수정 없이 그대로 복사하는 것 금지
    검증없이_main_적용_금지: verification_passed 없이 main 코드 수정 금지
    재현불가_폐기: 3회 시도 후 재현 불가한 논문은 폐기
    비용_상한: 단일 논문 LLM 비용 $5 초과 금지
    ops_직접수정_금지: OPS 시스템 직접 수정 금지

  sigma/v2/principle/loader.ex 패턴 포팅 + darwin 특화.
  """

  require Logger

  # darwin은 team_jay의 일부로 컴파일되므로 PROJECT_ROOT 기반 경로 사용
  @principles_path Path.join(
                     System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system"),
                     "bots/darwin/config/darwin_principles.yaml"
                   )

  # Tier 3 금지 규칙 하드코딩 폴백 (YAML 없을 때 사용)
  @tier3_fallback [
    %{
      id: "P-D001",
      desc: "다른 구현을 수정 없이 그대로 복사하는 것 금지",
      principle: "표절_금지",
      action: "copy_without_modification",
      description: "다른 구현을 수정 없이 그대로 복사하는 것 금지",
      keywords: ["copy_verbatim", "plagiarize", "copy_without_modification"]
    },
    %{
      id: "P-D002",
      desc: "verification_passed 없이 main 코드 수정 금지",
      principle: "검증없이_main_적용_금지",
      action: "apply_to_main",
      description: "verification_passed 없이 main 코드 수정 금지",
      keywords: ["skip_verification", "apply_to_main", "force_apply"]
    },
    %{
      id: "P-D003",
      desc: "3회 시도 후 재현 불가한 논문은 폐기",
      principle: "재현불가_폐기",
      action: "persist_unreproducible",
      description: "3회 시도 후 재현 불가한 논문은 폐기",
      keywords: ["unreproducible", "persist_failed", "keep_failed_paper"]
    },
    %{
      id: "P-D004",
      desc: "단일 논문 LLM 비용 $5 초과 금지",
      principle: "비용_상한",
      action: "exceed_paper_budget",
      description: "단일 논문 LLM 비용 $5 초과 금지",
      keywords: ["exceed_budget", "exceed_paper_budget", "overspend"]
    },
    %{
      id: "P-D005",
      desc: "OPS 시스템 직접 수정 금지",
      principle: "ops_직접수정_금지",
      action: "modify_ops_directly",
      description: "OPS 시스템 직접 수정 금지",
      keywords: ["modify_ops", "modify_ops_directly", "direct_ops_change"]
    }
  ]

  # ──────────────────────────────────────────────
  # Public API
  # ──────────────────────────────────────────────

  @doc "darwin_principles.yaml 로드 + 파싱."
  @spec load() :: {:ok, map()} | {:error, term()}
  def load do
    if File.exists?(@principles_path) do
      case YamlElixir.read_from_file(@principles_path) do
        {:ok, parsed} -> {:ok, parsed}
        {:error, reason} -> {:error, "yaml parse error: #{inspect(reason)}"}
      end
    else
      Logger.debug("[다윈V2 원칙] YAML 없음 — 하드코딩 폴백 사용: #{@principles_path}")
      {:error, "principles file not found: #{@principles_path}"}
    end
  end

  @doc """
  액션 실행 전 원칙 준수 여부 검사.
  1단계: keyword 매칭 (빠른 1차 필터)
  2단계: LLM 의미 기반 판정 (Kill Switch: DARWIN_PRINCIPLE_SEMANTIC_CHECK_ENABLED)

  action: 수행할 액션 이름/설명 (String 또는 atom)
  context: 추가 컨텍스트 map (paper_id, phase, skip_verification 등)
  """
  @spec check(String.t() | atom(), map()) ::
          {:approved, []} | {:blocked, [map()]}
  def check(action, context \\ %{}) do
    resolved_principles =
      case load() do
        {:ok, p} -> p
        _ -> %{}
      end

    # 1단계: keyword 매칭
    keyword_blocked = check_tier3_prohibitions(action, context, resolved_principles)

    cond do
      keyword_blocked != [] ->
        Logger.warning("[다윈V2 원칙] Tier 3 위반 (keyword): #{inspect(keyword_blocked)}")
        {:blocked, keyword_blocked}

      # 2단계: 의미 기반 LLM 판정 (Kill Switch)
      System.get_env("DARWIN_PRINCIPLE_SEMANTIC_CHECK_ENABLED") == "true" ->
        semantic_check(action, context, resolved_principles)

      true ->
        {:approved, []}
    end
  end

  @doc """
  하위 호환 API: map 형식 plan을 check/2로 위임.
  """
  @spec self_critique(map(), map() | nil) ::
          {:approved, []} | {:blocked, [String.t()]}
  def self_critique(plan, _principles \\ nil) do
    action = plan[:action] || plan["action"] || ""
    check(action, plan)
  end

  @doc "전체 하드코딩 원칙 목록 반환."
  @spec principles() :: [map()]
  def principles, do: @tier3_fallback

  # ──────────────────────────────────────────────
  # Private — keyword matching (1단계)
  # ──────────────────────────────────────────────

  defp check_tier3_prohibitions(action, context, principles) do
    tier3_rules = extract_tier3_rules(principles)
    action_str = to_string(action)

    tier3_rules
    |> Enum.filter(fn rule ->
      keywords = rule["keywords"] || rule[:keywords] || [rule["action"] || rule[:action] || ""]

      Enum.any?(keywords, fn kw ->
        String.contains?(action_str, to_string(kw))
      end) or check_context_flags(rule, context)
    end)
    |> Enum.map(fn rule ->
      %{
        id: rule[:id] || rule["id"] || (rule["principle"] || rule[:principle] || "unknown"),
        desc: rule[:desc] || rule["desc"] || rule["description"] || rule[:description] || ""
      }
    end)
  end

  # 컨텍스트 플래그 기반 추가 체크 (atom key + string key 둘 다 지원)
  defp check_context_flags(%{principle: "검증없이_main_적용_금지"}, context) do
    context[:skip_verification] == true or context["skip_verification"] == true
  end

  defp check_context_flags(%{"principle" => "검증없이_main_적용_금지"}, context) do
    context[:skip_verification] == true or context["skip_verification"] == true
  end

  defp check_context_flags(%{principle: "비용_상한"}, _context) do
    case Darwin.V2.LLM.CostTracker.check_budget() do
      {:error, :budget_exceeded} -> true
      _ -> false
    end
  rescue
    _ -> false
  end

  defp check_context_flags(%{"principle" => "비용_상한"}, _context) do
    case Darwin.V2.LLM.CostTracker.check_budget() do
      {:error, :budget_exceeded} -> true
      _ -> false
    end
  rescue
    _ -> false
  end

  defp check_context_flags(_, _), do: false

  defp extract_tier3_rules(principles) do
    tiers = principles["tiers"] || principles[:tiers] || []

    tier3 =
      Enum.find(tiers, fn t ->
        (t["tier"] || t[:tier]) == 3
      end) || %{}

    case tier3["prohibitions"] || tier3[:prohibitions] do
      nil -> @tier3_fallback
      [] -> @tier3_fallback
      rules -> rules
    end
  end

  # ──────────────────────────────────────────────
  # Private — LLM semantic check (2단계, Kill Switch 보호)
  # ──────────────────────────────────────────────

  defp semantic_check(action, context, principles) do
    tier3_rules = extract_tier3_rules(principles)

    prompt = """
    다음 다윈팀 지시(action)가 Tier 3 절대 금지 원칙을 위반하는지 판정하세요.

    [지시]
    action: #{inspect(action)}
    context: #{inspect(Map.take(context, [:phase, :paper_id, :skip_verification]))}

    [Tier 3 원칙 목록]
    #{Enum.map_join(tier3_rules, "\n", fn r ->
      p = r["principle"] || "?"
      d = r["description"] || ""
      "- #{p}: #{d}"
    end)}

    응답 형식: 정확히 한 줄
    - 위반 없음: [APPROVED]
    - 위반 있음: [BLOCKED] <위반한 원칙 이름>
    """

    case Darwin.V2.LLM.Selector.call_with_fallback(
           "darwin.evaluator",
           prompt,
           max_tokens: 60,
           urgency: :high,
           task_type: :structured_reasoning
         ) do
      {:ok, %{response: text}} ->
        if String.contains?(text, "[BLOCKED]") do
          violation = extract_violation(text)
          Logger.warning("[다윈V2 원칙] Tier 3 위반 (semantic): #{violation}")
          {:blocked, [%{id: "semantic", desc: violation}]}
        else
          {:approved, []}
        end

      {:error, _} ->
        # LLM 실패 시 안전하게 통과 (keyword 매칭으로 이미 1차 필터링됨)
        Logger.warning("[다윈V2 원칙] semantic check LLM 실패 — keyword-only로 통과")
        {:approved, []}
    end
  end

  defp extract_violation(text) do
    case Regex.run(~r/\[BLOCKED\]\s*(.+)/, String.trim(text)) do
      [_, violation] -> String.trim(violation)
      _ -> "semantic: #{String.slice(text, 0, 80)}"
    end
  end
end
