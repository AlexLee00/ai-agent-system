defmodule Darwin.V2.Skill.LearnFromCycle do
  @moduledoc "사이클 학습 스킬 — 완료된 R&D 사이클 결과를 RAG에 적재 + 자율 레벨 갱신."

  use Jido.Action,
    name: "darwin_learn_from_cycle",
    description: "R&D 사이클 완료 후 결과를 메모리에 저장하고 자율 레벨 카운터 갱신",
    schema: Zoi.object(%{
      cycle_id:    Zoi.string() |> Zoi.required(),
      outcome:     Zoi.enum([:success, :failure, :partial]) |> Zoi.required(),
      paper_title: Zoi.optional(Zoi.string()),
      metrics:     Zoi.default(Zoi.map(), %{}),
      applied:     Zoi.default(Zoi.boolean(), false)
    })

  require Logger

  @impl Jido.Action
  def run(%{cycle_id: cycle_id, outcome: outcome} = params, _ctx) do
    paper = params.paper_title || "unknown"
    metrics = params.metrics || %{}
    applied = params.applied || false

    case outcome do
      :success ->
        if applied do
          Darwin.V2.AutonomyLevel.record_applied_success()
        else
          Darwin.V2.AutonomyLevel.record_success()
        end

        store_learning(cycle_id, paper, outcome, metrics)
        Logger.info("[darwin/learn] 사이클 #{cycle_id} 성공 기록. 적용: #{applied}")
        {:ok, %{learned: true, autonomy_updated: true}}

      :failure ->
        Darwin.V2.AutonomyLevel.record_failure("cycle_#{cycle_id}")
        Darwin.V2.Reflexion.reflect(%{phase: "cycle", subject: paper, action: metrics}, metrics)
        store_learning(cycle_id, paper, outcome, metrics)
        Logger.info("[darwin/learn] 사이클 #{cycle_id} 실패 기록 + 반성 생성")
        {:ok, %{learned: true, reflected: true}}

      :partial ->
        store_learning(cycle_id, paper, outcome, metrics)
        Logger.info("[darwin/learn] 사이클 #{cycle_id} 부분 성공 기록")
        {:ok, %{learned: true}}
    end
  end

  defp store_learning(cycle_id, paper, outcome, metrics) do
    content = "사이클 #{cycle_id}: 논문 '#{paper}', 결과 #{outcome}, 메트릭 #{inspect(metrics)}"
    Darwin.V2.Memory.store({:cycle, cycle_id}, %{
      content: content,
      outcome: outcome,
      importance: outcome_importance(outcome)
    }, importance: outcome_importance(outcome))

    Darwin.V2.Memory.L2.run(
      %{operation: :store, content: content, team: "darwin", top_k: 5},
      %{}
    )
  end

  defp outcome_importance(:success), do: 0.6
  defp outcome_importance(:failure), do: 0.9
  defp outcome_importance(:partial), do: 0.5
end
