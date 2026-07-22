defmodule Sigma.V2.DirectiveContent do
  @moduledoc "Versioned, measurable content contract for Sigma advisory directives."

  @kpi_specs %{
    "content_ops" => [
      %{name: "published_7d", operator: ">=", value: 2, unit: "count"},
      %{name: "ready_count", operator: ">=", value: 1, unit: "count"}
    ],
    "trading_ops" => [
      %{name: "trades_7d", operator: ">=", value: 2, unit: "count"},
      %{name: "traded_usdt_7d", operator: ">=", value: 0, unit: "USDT"},
      %{name: "live_positions", operator: "<=", value: 5, unit: "count"}
    ],
    "research_ops" => [
      %{name: "total_collected", operator: ">=", value: 1, unit: "count"},
      %{name: "high_relevance", operator: ">=", value: 1, unit: "count"},
      %{name: "duration_sec", operator: "<=", value: 300, unit: "seconds"}
    ],
    "agent_health" => [
      %{name: "active_agents", operator: ">=", value: 1, unit: "count"},
      %{name: "avg_score", operator: ">=", value: 5, unit: "score"},
      %{name: "low_score_agents", operator: "<=", value: 0, unit: "count"}
    ],
    "workflow_tuning" => [
      %{name: "unhealthy_services", operator: "<=", value: 0, unit: "count"}
    ],
    "knowledge_capture" => [
      %{name: "new_experiences", operator: ">=", value: 10, unit: "count"}
    ]
  }

  @spec build(map()) :: map()
  def build(feedback) when is_map(feedback) do
    team = text_value(feedback, :target_team, "unknown")
    feedback_type = text_value(feedback, :feedback_type, "general_review")
    metric = map_value(feedback, :before_metric)
    purpose = text_value(feedback, :content, "#{team} 운영 지표를 점검하고 다음 조치를 보고하세요.")

    %{
      schema_version: "sigma.directive.v1",
      target_team: team,
      owner: team,
      purpose: purpose,
      content: purpose,
      feedback_type: feedback_type,
      kpis: build_kpis(metric, feedback_type),
      cadence: %{measure_every: "P1D", report_every: "P1D"},
      report_format: %{
        format: "markdown",
        required_sections: ["kpi_snapshot", "threshold_breaches", "next_actions"]
      }
    }
  end

  defp build_kpis(metric, feedback_type) do
    metric_type = text_value(metric, :metric_type, feedback_type)
    specs = Map.get(@kpi_specs, metric_type, fallback_specs(metric))

    Enum.map(specs, fn spec ->
      %{
        name: spec.name,
        current_value: numeric_value(metric, spec.name),
        threshold: %{operator: spec.operator, value: spec.value},
        unit: spec.unit
      }
    end)
  end

  defp fallback_specs(metric) do
    cond do
      has_key?(metric, "unhealthy_services") -> Map.fetch!(@kpi_specs, "workflow_tuning")
      has_key?(metric, "new_experiences") -> Map.fetch!(@kpi_specs, "knowledge_capture")
      true -> [%{name: "metric_available", operator: ">=", value: 1, unit: "boolean"}]
    end
  end

  defp has_key?(map, key), do: Map.has_key?(map, key) or Map.has_key?(map, String.to_atom(key))

  defp map_value(map, key) do
    case Map.get(map, key) || Map.get(map, Atom.to_string(key)) do
      value when is_map(value) -> value
      _ -> %{}
    end
  end

  defp text_value(map, key, fallback) do
    value = Map.get(map, key) || Map.get(map, Atom.to_string(key))
    normalized = value |> to_string_safe() |> String.trim()
    if normalized == "", do: fallback, else: normalized
  end

  defp numeric_value(metric, name) do
    value = Map.get(metric, name) || Map.get(metric, String.to_atom(name))

    cond do
      is_integer(value) or is_float(value) ->
        value

      is_binary(value) ->
        case Float.parse(value) do
          {parsed, ""} -> parsed
          _ -> 0
        end

      name == "metric_available" and map_size(metric) > 0 ->
        1

      true ->
        0
    end
  end

  defp to_string_safe(nil), do: ""
  defp to_string_safe(value) when is_binary(value), do: value
  defp to_string_safe(value), do: to_string(value)
end
