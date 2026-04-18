defmodule Sigma.V2.Reflexion do
  @moduledoc """
  Reflexion 패턴 (arXiv 2303.11366).
  Directive 실패 시 LLM이 자연어 리플렉션 생성 → procedural memory 저장.
  LLM: Sigma.V2.LLM.Selector.call_with_fallback(:reflexion, prompt, opts) 경유.
  참조: bots/sigma/docs/PLAN.md §6 Phase 3
  """

  require Logger

  @doc "실패한 Directive에 대한 리플렉션 생성 + 메모리 저장."
  def reflect(directive, outcome) do
    team = get_field(directive, :team, "unknown")
    analyst = get_field(directive, :analyst, "unknown")
    action = get_field(directive, :action, %{})

    prompt = """
    시그마 분석가 "#{analyst}"가 팀 "#{team}"에
    다음 피드백을 제공했으나 예상보다 효과가 낮았습니다.

    피드백 내용: #{inspect(action)}
    실제 effectiveness: #{outcome[:effectiveness] || 0.0}
    metric 변화: #{inspect(outcome[:metric_delta] || %{})}

    다음 3가지 질문에 각 2~3줄로 답하세요:
    1. 왜 이 피드백이 효과적이지 않았을 가능성이 높은가?
    2. 같은 상황에서 어떤 다른 피드백이 더 나았을까?
    3. 이런 상황을 사전 식별하려면 어떤 신호를 봐야 하는가?
    """

    reflection_text =
      case Sigma.V2.LLM.Selector.call_with_fallback(:reflexion, prompt, max_tokens: 500) do
        {:ok, %{response: text}} when is_binary(text) and text != "" -> text
        {:ok, resp} -> inspect(resp)
        {:error, reason} ->
          Logger.warning("[sigma/reflexion] LLM 호출 실패: #{inspect(reason)}")
          "reflection_unavailable"
      end

    rollback_spec = get_field(directive, :rollback_spec, %{})

    directive_id =
      get_in(rollback_spec, [:directive_id]) ||
        get_in(rollback_spec, ["directive_id"]) ||
        Ecto.UUID.generate()

    entry = %{
      feedback_id: directive_id,
      analyst: analyst,
      team: team,
      reflection: reflection_text,
      tags: extract_tags(reflection_text),
      created_at: DateTime.utc_now()
    }

    Sigma.V2.Memory.store(:procedural, entry, importance: 0.7)
    Sigma.V2.Archivist.log_reflexion(entry)

    {:ok, entry}
  rescue
    e ->
      Logger.error("[sigma/reflexion] 예외 발생: #{inspect(e)}")
      {:error, e}
  end

  # ---

  defp extract_tags(text) when is_binary(text) do
    text
    |> String.split(~r/\s+/)
    |> Enum.filter(&(String.length(&1) > 4))
    |> Enum.uniq()
    |> Enum.take(5)
  end
  defp extract_tags(_), do: []

  defp get_field(value, key, default) when is_map(value) do
    Map.get(value, key) || Map.get(value, Atom.to_string(key)) || default
  end

  defp get_field(_value, _key, default), do: default
end
