defmodule Sigma.V2.Skill.FeaturePlanner do
  @moduledoc """
  FeaturePlanner — 피처 엔지니어링 계획 및 중요도 평가.
  TS packages/core/lib/skills/sigma/feature-planner.ts 1:1 포팅.
  """

  use Jido.Action,
    name: "sigma_v2_feature_planner",
    description: "Plan feature engineering and prioritization for team analytics",
    schema: Zoi.object(%{
      candidates: Zoi.default(Zoi.list(), [])
    })

  @impl Jido.Action
  def run(params, _ctx) do
    candidates = params.candidates || []

    {prioritized, high_risk, quick_wins} =
      Enum.reduce(candidates, {[], [], []}, fn candidate, {pri, hr, qw} ->
        name = to_string(candidate[:name] || candidate["name"] || "feature")
        effort = to_number(candidate[:effort] || candidate["effort"], 5)
        signal = to_number(candidate[:signal] || candidate["signal"], 0)
        leakage_risk = truthy?(candidate[:leakage_risk] || candidate["leakage_risk"])

        score = Float.round(signal * 2.0 - effort - (if leakage_risk, do: 2.0, else: 0.0), 1)

        item = %{name: name, score: score, effort: effort, signal: signal, leakage_risk: leakage_risk}

        hr2 = if leakage_risk, do: hr ++ [name], else: hr
        qw2 = if !leakage_risk and effort <= 3 and signal >= 3, do: qw ++ [name], else: qw

        {pri ++ [item], hr2, qw2}
      end)

    sorted = Enum.sort_by(prioritized, & &1.score, :desc)

    {:ok, %{
      prioritized_features: sorted,
      high_risk_features: high_risk,
      quick_wins: quick_wins
    }}
  end

  defp to_number(nil, default), do: default
  defp to_number(v, _) when is_number(v), do: v * 1.0
  defp to_number(v, default) when is_binary(v) do
    case Float.parse(v) do
      {f, _} -> f
      _ -> default * 1.0
    end
  end
  defp to_number(_, default), do: default * 1.0

  defp truthy?(nil), do: false
  defp truthy?(false), do: false
  defp truthy?(0), do: false
  defp truthy?(""), do: false
  defp truthy?(_), do: true
end
