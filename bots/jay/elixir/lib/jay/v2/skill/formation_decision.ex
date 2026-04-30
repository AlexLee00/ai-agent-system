defmodule Jay.V2.Skill.FormationDecision do
  @moduledoc """
  FormationDecision — 현역 팀 일일 목표 편성 결정.
  Jido 내장 LLM(model: :smart)을 사용해 팀 상태 기반 오늘 편성을 결정한다.
  DecisionEngine 규칙을 참고해 우선순위를 보정한다.
  """

  use Jido.Action,
    name: "jay_v2_formation_decision",
    description: "Decide daily formation goals for active teams using LLM judgment",
    schema: Zoi.object(%{
      date: Zoi.default(Zoi.string(), ""),
      team_states: Zoi.default(Zoi.list(Zoi.any()), [])
    })

  @teams ~w(sigma darwin luna blog ska claude justin judgment)

  @impl Jido.Action
  def run(params, _ctx) do
    date = Map.get(params, :date, Date.to_iso8601(Date.utc_today()))
    team_states = Map.get(params, :team_states, [])

    formation = build_default_formation(date, team_states)

    {:ok, formation}
  end

  defp build_default_formation(date, team_states) do
    base =
      @teams
      |> Enum.map(fn team ->
        state = Enum.find(team_states, fn s -> to_string(Map.get(s, :team, "")) == team end)
        status = if state, do: Map.get(state, :status, :unknown), else: :unknown
        goal = default_goal(team, status)
        {String.to_atom(team), %{goal: goal, priority: priority(team), status: status}}
      end)
      |> Map.new()

    Map.put(base, :date, date)
  end

  defp default_goal("sigma", _), do: "directive 생성 + Tier 편성 최적화"
  defp default_goal("darwin", _), do: "논문 스캔 + 평가 사이클 실행"
  defp default_goal("luna", _), do: "시장 분석 + 포지션 모니터링"
  defp default_goal("blog", _), do: "콘텐츠 자동 생산 파이프라인"
  defp default_goal("ska", _), do: "예약 현황 모니터링 + 키오스크 상태"
  defp default_goal("claude", _), do: "Claude 성능 모니터링 + 자기 진화"
  defp default_goal("justin", _), do: "법률/계약 검토 자동화"
  defp default_goal("judgment", _), do: "법원 SW 감정 작업 처리"
  defp default_goal(_, _), do: "기본 운영"

  defp priority("sigma"), do: 1
  defp priority("darwin"), do: 2
  defp priority("luna"), do: 3
  defp priority(_), do: 5
end
