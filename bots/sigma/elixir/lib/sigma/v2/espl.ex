defmodule Sigma.V2.ESPL do
  @moduledoc """
  E-SPL (Evolutionary System Prompt Learning) — arXiv 2602.14697.
  시그마 분석가 프롬프트를 유전 알고리즘으로 주간 진화.
  SIGMA_GEPA_ENABLED=false 기본 (Kill Switch).
  LLM: Sigma.V2.LLM.Selector.call_with_fallback(:espl, ...) 경유.
  참조: bots/sigma/docs/PLAN.md §6 Phase 4
  """

  require Logger

  @doc "주간 진화 루프 — 금요일 MetaReview 직후 자동 호출."
  def evolve_weekly do
    unless System.get_env("SIGMA_GEPA_ENABLED") == "true" do
      Logger.info("[sigma/espl] SIGMA_GEPA_ENABLED=false — 진화 건너뜀")
      {:error, :espl_disabled}
    else
      do_evolve()
    end
  end

  # ---

  defp do_evolve do
    population = Sigma.V2.Registry.current_prompts()

    if population == [] do
      Logger.info("[sigma/espl] 현재 세대 없음 — 진화 건너뜀")
      {:ok, %{generation: 0, survivors: [], offspring: [], max_fitness: 0.0}}
    else
      fitness = Sigma.V2.Metric.weekly_effectiveness_by_analyst()
      survivors = tournament_selection(population, fitness, 3)

      offspring =
        if survivors == [] do
          []
        else
          generate_offspring(survivors)
        end

      unless offspring == [] do
        Sigma.V2.Registry.propose_generation(offspring)
      end

      next_gen = Sigma.V2.Metric.next_generation_number()
      max_fit =
        fitness
        |> Enum.max_by(& &1.score, fn -> %{score: 0.0} end)
        |> Map.get(:score, 0.0)

      Logger.info("[sigma/espl] 진화 완료 — generation=#{next_gen} survivors=#{length(survivors)} offspring=#{length(offspring)}")

      {:ok, %{
        generation: next_gen,
        survivors: Enum.map(survivors, &(&1[:name] || &1.name || "unknown")),
        offspring: Enum.map(offspring, &(&1[:name] || &1.name || "child")),
        max_fitness: Float.round(max_fit * 1.0, 3)
      }}
    end
  rescue
    e ->
      Logger.error("[sigma/espl] 예외 발생: #{inspect(e)}")
      {:error, e}
  end

  defp tournament_selection(population, fitness, k) do
    fitness_map = Map.new(fitness, &{&1.name, &1.score})

    population
    |> Enum.sort_by(fn p ->
      name = p[:name] || p.name || "unknown"
      -(Map.get(fitness_map, name, 0.0))
    end)
    |> Enum.take(k)
  end

  defp generate_offspring(survivors) do
    Enum.flat_map(survivors, fn parent ->
      other = Enum.random(survivors)

      [
        crossover_prompt(parent, other),
        mutate_prompt(parent)
      ]
    end)
    |> Enum.reject(&is_nil/1)
  end

  defp crossover_prompt(parent_a, parent_b) do
    name_a = parent_a[:name] || "parent_a"
    name_b = parent_b[:name] || "parent_b"
    prompt_a = parent_a[:system_prompt] || ""
    prompt_b = parent_b[:system_prompt] || ""
    gen = (parent_a[:generation] || 0) + 1

    prompt = """
    다음 두 분석가 프롬프트를 혼합하여 새로운 프롬프트를 생성하세요.

    [Parent A: #{name_a}]
    #{String.slice(prompt_a, 0, 500)}

    [Parent B: #{name_b}]
    #{String.slice(prompt_b, 0, 500)}

    [Task] 두 프롬프트의 강점을 유지하고 약점을 회피하세요.
    길이는 원본 평균 수준으로, 새 프롬프트만 출력하세요.
    """

    case Sigma.V2.LLM.Selector.call_with_fallback(:espl, prompt, max_tokens: 800) do
      {:ok, %{response: new_prompt}} when is_binary(new_prompt) and new_prompt != "" ->
        %{
          name: "#{name_a}_x_#{name_b}",
          system_prompt: new_prompt,
          generation: gen,
          parents: [name_a, name_b]
        }

      _ ->
        nil
    end
  end

  defp mutate_prompt(parent) do
    name = parent[:name] || "parent"
    prompt_text = parent[:system_prompt] || ""
    gen = (parent[:generation] || 0) + 1

    prompt = """
    다음 분석가 프롬프트에 2~3개의 작은 개선을 추가하세요.
    원본 의도는 유지하고 표현을 더 정확하게 만드세요.

    [Original: #{name}]
    #{String.slice(prompt_text, 0, 500)}

    [Task] 개선된 프롬프트만 출력하세요.
    """

    case Sigma.V2.LLM.Selector.call_with_fallback(:espl, prompt, max_tokens: 800) do
      {:ok, %{response: mutated}} when is_binary(mutated) and mutated != "" ->
        %{
          name: "#{name}_mut",
          system_prompt: mutated,
          generation: gen,
          parents: [name]
        }

      _ ->
        nil
    end
  end
end
