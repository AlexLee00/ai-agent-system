defmodule Darwin.V2.ESPL do
  @moduledoc """
  E-SPL (Evolutionary System Prompt Learning) — arXiv 2602.14697.
  다윈 evaluator/planner/verifier 프롬프트를 유전 알고리즘으로 주간 진화.

  Kill switch: Darwin.V2.Config.espl_enabled?()

  Operators:
    crossover_prompt — 두 최우수 프롬프트 혼합
    mutate_prompt    — 단일 프롬프트 미세 조정

  DB 테이블: darwin_agent_prompts
  컬럼: agent_name, prompt, generation, status (operational/shadow/archived),
         effectiveness, inserted_at

  대상 에이전트: darwin.evaluator, darwin.planner, darwin.verifier

  LLM: Darwin.V2.LLM.Selector.call_with_fallback("espl.crossover" | "espl.mutation", ...) 경유.
  """

  require Logger

  @target_agents ["darwin.evaluator", "darwin.planner", "darwin.verifier"]
  @prompts_table "darwin_agent_prompts"

  # ──────────────────────────────────────────────
  # Public API
  # ──────────────────────────────────────────────

  @doc """
  주간 진화 루프 — 주간 사이클 완료 후 자동 호출.
  Kill switch off 시 건너뜀.
  """
  @spec run_weekly() :: {:ok, map()} | {:error, term()}
  def run_weekly do
    unless Darwin.V2.Config.espl_enabled?() do
      Logger.info("[다윈V2 ESPL] Kill switch 비활성 — 진화 건너뜀")
      {:error, :espl_disabled}
    else
      do_run_weekly()
    end
  end

  @doc "run_weekly/0 하위 호환 별칭."
  @spec evolve_weekly() :: {:ok, map()} | {:error, term()}
  defdelegate evolve_weekly(), to: __MODULE__, as: :run_weekly

  @doc """
  단일 에이전트 프롬프트 진화 (shadow 세대 제안).
  """
  @spec evolve(String.t()) :: {:ok, map()} | {:error, term()}
  def evolve(agent_name) do
    unless Darwin.V2.Config.espl_enabled?() do
      Logger.info("[다윈V2 ESPL] Kill switch 비활성 — #{agent_name} 진화 건너뜀")
      {:error, :espl_disabled}
    else
      Logger.info("[다윈V2 ESPL] #{agent_name} 진화 시작")
      do_evolve(agent_name)
    end
  end

  @doc "에이전트의 현재 operational 프롬프트 반환."
  @spec current_prompt(String.t()) :: String.t() | nil
  def current_prompt(agent_name) do
    sql = """
    SELECT prompt
    FROM #{@prompts_table}
    WHERE agent_name = $1
      AND status = 'operational'
    ORDER BY generation DESC
    LIMIT 1
    """

    case Jay.Core.Repo.query(sql, [agent_name]) do
      {:ok, %{rows: [[prompt]]}} -> prompt
      _ -> nil
    end
  rescue
    _ -> nil
  end

  # ──────────────────────────────────────────────
  # Private
  # ──────────────────────────────────────────────

  defp do_run_weekly do
    results =
      Enum.map(@target_agents, fn agent ->
        case do_evolve(agent) do
          {:ok, result} -> {agent, result}
          {:error, e} -> {agent, {:error, e}}
        end
      end)

    Logger.info("[다윈V2 ESPL] 주간 프롬프트 진화 완료: #{Enum.count(results)}개 에이전트")
    {:ok, Map.new(results)}
  rescue
    e ->
      Logger.error("[다윈V2 ESPL] 예외 발생: #{inspect(e)}")
      {:error, e}
  end

  defp do_evolve(agent_name) do
    with {:ok, operational} <- load_operational(agent_name),
         {:ok, top_two} <- load_top_two(agent_name),
         {:ok, crossed} <- crossover_prompt(agent_name, top_two, operational),
         {:ok, mutated} <- mutate_prompt(agent_name, crossed),
         next_gen <- next_generation(agent_name) do
      save_shadow(agent_name, mutated, next_gen)
      {:ok, %{agent: agent_name, generation: next_gen, prompt_length: String.length(mutated)}}
    end
  end

  defp load_operational(agent_name) do
    case current_prompt(agent_name) do
      nil -> {:ok, default_prompt(agent_name)}
      prompt -> {:ok, prompt}
    end
  end

  defp load_top_two(agent_name) do
    sql = """
    SELECT prompt, effectiveness
    FROM #{@prompts_table}
    WHERE agent_name = $1
      AND status IN ('operational', 'shadow')
    ORDER BY effectiveness DESC NULLS LAST, generation DESC
    LIMIT 2
    """

    case Jay.Core.Repo.query(sql, [agent_name]) do
      {:ok, %{rows: rows}} ->
        prompts = Enum.map(rows, fn [p, _eff] -> p end)
        {:ok, prompts}

      _ ->
        {:ok, []}
    end
  rescue
    _ -> {:ok, []}
  end

  defp next_generation(agent_name) do
    sql = "SELECT COALESCE(MAX(generation), 0) + 1 FROM #{@prompts_table} WHERE agent_name = $1"

    case Jay.Core.Repo.query(sql, [agent_name]) do
      {:ok, %{rows: [[n]]}} -> n
      _ -> 1
    end
  rescue
    _ -> 1
  end

  @doc "두 최우수 프롬프트를 혼합하여 새 프롬프트 생성."
  @spec crossover_prompt(String.t(), [String.t()], String.t()) ::
          {:ok, String.t()}
  def crossover_prompt(_agent_name, [], operational), do: {:ok, operational}
  def crossover_prompt(_agent_name, [single], _operational), do: {:ok, single}
  def crossover_prompt(agent_name, [p1, p2 | _], _operational) do
    prompt = """
    다음 두 #{agent_name} 프롬프트를 혼합하여 각각의 강점을 유지하는 새 프롬프트를 생성하세요.

    [프롬프트 A]
    #{String.slice(p1, 0, 500)}

    [프롬프트 B]
    #{String.slice(p2, 0, 500)}

    두 프롬프트의 강점을 유지하고 약점을 회피하세요.
    길이는 원본 평균 수준으로, 새 프롬프트만 출력하세요.
    """

    case Darwin.V2.LLM.Selector.call_with_fallback("espl.crossover", prompt,
           max_tokens: 800,
           task_type: :creative_generation
         ) do
      {:ok, %{response: text}} when is_binary(text) and text != "" ->
        Logger.debug("[다윈V2 ESPL] #{agent_name} crossover 완료")
        {:ok, text}

      _ ->
        {:ok, p1}
    end
  end

  @doc "단일 프롬프트에 미세 조정을 적용하여 새 프롬프트 생성."
  @spec mutate_prompt(String.t(), String.t()) :: {:ok, String.t()}
  def mutate_prompt(agent_name, prompt_text) do
    mutation_prompt = """
    다음 #{agent_name} 프롬프트에 2~3개의 작은 개선을 추가하세요.
    원본 의도는 유지하고 표현을 더 정확하게 만드세요.

    [원본 프롬프트]
    #{String.slice(prompt_text, 0, 500)}

    개선된 프롬프트만 출력하세요.
    """

    case Darwin.V2.LLM.Selector.call_with_fallback("espl.mutation", mutation_prompt,
           max_tokens: 600,
           task_type: :creative_generation
         ) do
      {:ok, %{response: text}} when is_binary(text) and text != "" ->
        Logger.debug("[다윈V2 ESPL] #{agent_name} mutation 완료")
        {:ok, text}

      _ ->
        {:ok, prompt_text}
    end
  end

  defp save_shadow(agent_name, prompt_text, generation) do
    sql = """
    INSERT INTO #{@prompts_table}
      (agent_name, prompt, generation, status, effectiveness, inserted_at)
    VALUES ($1, $2, $3, 'shadow', NULL, NOW())
    """

    case Jay.Core.Repo.query(sql, [agent_name, prompt_text, generation]) do
      {:ok, _} ->
        Logger.info("[다윈V2 ESPL] #{agent_name} shadow 프롬프트 저장 — generation=#{generation}")

      {:error, reason} ->
        Logger.error("[다윈V2 ESPL] #{agent_name} shadow 저장 실패: #{inspect(reason)}")
    end
  rescue
    e -> Logger.error("[다윈V2 ESPL] save_shadow 예외: #{inspect(e)}")
  end

  defp default_prompt("darwin.evaluator") do
    "당신은 AI 연구 논문 평가자입니다. 논문의 신규성, 구현 가능성, 시스템 적용 가능성을 0~10점으로 평가하세요."
  end

  defp default_prompt("darwin.planner") do
    "당신은 AI 연구 구현 계획자입니다. 논문의 핵심 알고리즘을 분해하고 단계별 구현 계획을 수립하세요."
  end

  defp default_prompt("darwin.verifier") do
    "당신은 AI 연구 구현 검증자입니다. 구현의 정확성, 보안, 성능을 검증하고 개선점을 제안하세요."
  end

  defp default_prompt(_), do: "당신은 AI 연구 보조자입니다."
end
