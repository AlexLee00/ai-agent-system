defmodule Darwin.V2.Skill.TreeSearch do
  @moduledoc """
  TreeSearch — 에디슨이 막혔을 때 대안 구현 경로를 탐색.

  AI Scientist-v2 (Sakana AI) progressive agentic tree-search 패턴 기반.

  트리 구조:
    - Root: 논문 구현 목표
    - 각 노드: 구현 시도 + 품질 점수
    - 분기: 품질 < quality_threshold일 때 LLM이 N개 대안 생성
    - 가지치기: 품질 < 5.0 OR 깊이 >= max_depth OR 너비 >= max_width OR 총 노드 >= 20

  알고리즘:
    1. Root 시도 (원래 논문 접근법)
    2. 품질 < threshold: LLM으로 대안 분기 생성
    3. 각 분기 점수화
    4. 최고 분기 확장, 나머지 가지치기
    5. 중지 조건 달성 시 종료

  LLM: Darwin.V2.LLM.Selector (agent "darwin.planner")
  원칙 체크: Darwin.V2.Principle.Loader.check/2
  """

  use Jido.Action,
    name: "darwin_v2_tree_search",
    description: "Explore alternative implementation paths via progressive tree search",
    schema: Zoi.object(%{
      implementation_goal: Zoi.string() |> Zoi.required(),
      paper_context:       Zoi.map() |> Zoi.required(),
      max_depth:           Zoi.default(Zoi.integer(), 3),
      max_width:           Zoi.default(Zoi.integer(), 5),
      quality_threshold:   Zoi.default(Zoi.float(), 7.0)
    })

  require Logger

  @agent "darwin.planner"
  @log_prefix "[다윈V2 스킬:트리탐색]"
  @max_total_nodes 20
  @prune_threshold 5.0

  @impl Jido.Action
  def run(params, _ctx) do
    goal      = Map.fetch!(params, :implementation_goal)
    paper_ctx = Map.fetch!(params, :paper_context)
    max_depth = Map.get(params, :max_depth, 3)
    max_width = Map.get(params, :max_width, 5)
    threshold = Map.get(params, :quality_threshold, 7.0)

    Logger.info("#{@log_prefix} 시작 — goal=#{String.slice(goal, 0, 80)}")

    with :ok <- check_principle(goal, paper_ctx) do
      state = %{
        goal:             goal,
        paper_ctx:        paper_ctx,
        max_depth:        max_depth,
        max_width:        max_width,
        threshold:        threshold,
        nodes_explored:   0,
        abandoned:        0
      }

      case run_tree_search(state) do
        {:ok, result} ->
          Logger.info("#{@log_prefix} 완료 — quality=#{result.final_quality}, nodes=#{result.nodes_explored}")
          {:ok, result}

        {:error, reason} ->
          Logger.error("#{@log_prefix} 실패 — #{inspect(reason)}")
          {:error, reason}
      end
    end
  end

  # --- 트리 탐색 메인 루프 ---

  defp run_tree_search(state) do
    # Root 노드 생성
    root_approach = build_root_approach(state.goal, state.paper_ctx)

    case score_node(root_approach, state.goal, state.paper_ctx) do
      {:ok, root_node} ->
        search_state = %{state | nodes_explored: 1}

        if root_node.quality >= state.threshold do
          # Root가 이미 충분한 품질
          {:ok, %{
            best_path:         [root_node],
            final_quality:     root_node.quality,
            nodes_explored:    1,
            abandoned_branches: 0
          }}
        else
          expand_node(root_node, [root_node], search_state)
        end

      {:error, reason} ->
        {:error, {:root_scoring_failed, reason}}
    end
  end

  defp expand_node(current_node, path, state) do
    depth = length(path)

    # 중지 조건 확인
    cond do
      state.nodes_explored >= @max_total_nodes ->
        Logger.info("#{@log_prefix} 최대 노드 수 도달 (#{@max_total_nodes})")
        {:ok, build_result(path, current_node.quality, state)}

      depth >= state.max_depth ->
        Logger.info("#{@log_prefix} 최대 깊이 도달 (#{depth})")
        {:ok, build_result(path, current_node.quality, state)}

      current_node.quality >= state.threshold ->
        Logger.info("#{@log_prefix} 품질 임계값 달성 (#{current_node.quality})")
        {:ok, build_result(path, current_node.quality, state)}

      true ->
        # 대안 분기 생성
        case generate_alternatives(current_node, state) do
          {:ok, alternatives} ->
            scored_alternatives = score_alternatives(alternatives, state.goal, state.paper_ctx)
            valid_branches = Enum.filter(scored_alternatives, &(&1.quality >= @prune_threshold))
            pruned_count = length(scored_alternatives) - length(valid_branches)

            new_state = %{state |
              nodes_explored: state.nodes_explored + length(scored_alternatives),
              abandoned: state.abandoned + pruned_count
            }

            case Enum.max_by(valid_branches, & &1.quality, fn -> nil end) do
              nil ->
                # 모든 분기 가지치기됨 — 현재 결과 반환
                Logger.info("#{@log_prefix} 모든 분기 가지치기 — 현재 경로 반환")
                {:ok, build_result(path, current_node.quality, new_state)}

              best_branch ->
                Logger.info("#{@log_prefix} 최고 분기 선택 quality=#{best_branch.quality}, depth=#{depth + 1}")
                expand_node(best_branch, path ++ [best_branch], new_state)
            end

          {:error, reason} ->
            Logger.warning("#{@log_prefix} 분기 생성 실패 (#{inspect(reason)}) — 현재 결과 반환")
            {:ok, build_result(path, current_node.quality, state)}
        end
    end
  end

  # --- 노드 점수화 ---

  defp score_node(approach, goal, paper_ctx) do
    prompt = """
    You are a research engineer evaluating an implementation approach.

    Goal: #{goal}
    Paper: #{Map.get(paper_ctx, :title, Map.get(paper_ctx, "title", ""))}
    Key Algorithm: #{Map.get(paper_ctx, :key_algorithm, Map.get(paper_ctx, "key_algorithm", ""))}

    Approach to evaluate:
    #{approach}

    Score this approach on:
    - Correctness (does it match the paper's method?)
    - Feasibility (can it be implemented with standard tools?)
    - Completeness (does it cover all key aspects?)

    Respond in valid JSON:
    {
      "quality": 7.5,
      "code_sketch": "# Brief code sketch\\ndef main():\\n    ...",
      "reason_for_branching": "Missing gradient computation step"
    }
    Quality scale: 0-10 (7+ = good enough, 5-7 = needs improvement, <5 = abandon)
    """

    case Darwin.V2.LLM.Selector.call_with_fallback(@agent, prompt, max_tokens: 1024) do
      {:ok, %{response: text}} ->
        case parse_json(text) do
          {:ok, parsed} ->
            node = %{
              approach:              approach,
              quality:               to_float(Map.get(parsed, "quality", 5.0)),
              code_sketch:           Map.get(parsed, "code_sketch", ""),
              reason_for_branching:  Map.get(parsed, "reason_for_branching", "")
            }
            {:ok, node}

          {:error, _} ->
            # 파싱 실패 시 중간 품질 노드 반환
            {:ok, %{approach: approach, quality: 5.5, code_sketch: "", reason_for_branching: "JSON parse failed"}}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp score_alternatives(alternatives, goal, paper_ctx) do
    Enum.map(alternatives, fn alt ->
      case score_node(alt, goal, paper_ctx) do
        {:ok, node} -> node
        {:error, _} -> %{approach: alt, quality: 0.0, code_sketch: "", reason_for_branching: "scoring failed"}
      end
    end)
  end

  # --- 대안 생성 ---

  defp generate_alternatives(current_node, state) do
    n_branches = min(state.max_width, @max_total_nodes - state.nodes_explored)

    if n_branches <= 0 do
      {:ok, []}
    else
      prompt = """
      You are a creative research engineer. Generate alternative implementation approaches.

      Goal: #{state.goal}
      Paper: #{Map.get(state.paper_ctx, :title, Map.get(state.paper_ctx, "title", ""))}

      Current approach (quality #{current_node.quality}/10):
      #{current_node.approach}

      Problem with current approach:
      #{current_node.reason_for_branching}

      Generate #{n_branches} DISTINCT alternative approaches. Each should address the weakness.
      Think outside the box: different algorithms, different frameworks, different decompositions.

      Respond in valid JSON:
      {
        "alternatives": [
          "Alternative approach 1: ...",
          "Alternative approach 2: ...",
          ...
        ]
      }
      """

      case Darwin.V2.LLM.Selector.call_with_fallback(@agent, prompt, max_tokens: 1024) do
        {:ok, %{response: text}} ->
          case parse_json(text) do
            {:ok, %{"alternatives" => alts}} when is_list(alts) ->
              {:ok, Enum.take(alts, n_branches)}

            {:ok, _} ->
              {:ok, []}

            {:error, _} ->
              {:ok, []}
          end

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  # --- 헬퍼 ---

  defp build_root_approach(goal, paper_ctx) do
    title     = Map.get(paper_ctx, :title,         Map.get(paper_ctx, "title", ""))
    abstract  = Map.get(paper_ctx, :abstract,      Map.get(paper_ctx, "abstract", ""))
    algorithm = Map.get(paper_ctx, :key_algorithm, Map.get(paper_ctx, "key_algorithm", ""))

    """
    Implement the following research paper directly as described:

    Goal: #{goal}
    Paper: #{title}
    Abstract summary: #{String.slice(abstract, 0, 500)}
    Key algorithm: #{algorithm}

    Approach: Follow the paper's methodology step-by-step using standard implementations.
    """
  end

  defp build_result(path, final_quality, state) do
    %{
      best_path:          path,
      final_quality:      final_quality,
      nodes_explored:     state.nodes_explored,
      abandoned_branches: state.abandoned
    }
  end

  defp check_principle(goal, paper_ctx) do
    case Darwin.V2.Principle.Loader.check(:tree_search, %{goal: goal, paper_ctx: paper_ctx}) do
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
      :error -> 5.0
    end
  end
  defp to_float(_), do: 5.0

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
