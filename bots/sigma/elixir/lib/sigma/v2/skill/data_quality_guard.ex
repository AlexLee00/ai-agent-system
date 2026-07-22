defmodule Sigma.V2.Skill.DataQualityGuard do
  @moduledoc """
  DataQualityGuard — 중복/누락/신선도/이상값 검사.
  TS packages/core/lib/skills/sigma/data-quality-guard.ts 1:1 포팅.
  """

  use Jido.Action,
    name: "sigma_v2_data_quality_guard",
    description: "Evaluate dataset for duplicates/missing/stale/outliers",
    schema: Zoi.object(%{
      rows: Zoi.list() |> Zoi.required(),
      required_fields: Zoi.default(Zoi.list(Zoi.string()), []),
      freshness_field: Zoi.optional(Zoi.string()),
      freshness_threshold_days: Zoi.default(Zoi.integer(), 7),
      numeric_fields: Zoi.default(Zoi.list(Zoi.string()), [])
    })

  @impl Jido.Action
  def run(params, _ctx) do
    rows = Map.get(params, :rows, []) || []
    required_fields = Map.get(params, :required_fields, []) || []
    freshness_field = Map.get(params, :freshness_field)
    freshness_threshold_days = Map.get(params, :freshness_threshold_days, 7) || 7
    numeric_fields = Map.get(params, :numeric_fields, []) || []

    if rows == [] do
      {:ok, %{
        passed: false,
        quality_score: 0,
        issues: [%{type: "empty_dataset", count: 0}],
        stats: %{total_rows: 0, duplicate_rows: 0, missing_rows: 0, stale_rows: 0, outlier_rows: 0}
      }}
    else
      duplicate_rows = count_duplicates(rows)
      missing_rows = count_missing(rows, required_fields)
      stale_rows = count_stale(rows, freshness_field, freshness_threshold_days)
      {outlier_rows, outlier_issues} = count_outliers(rows, numeric_fields)

      issues =
        []
        |> maybe_add(duplicate_rows > 0, %{type: "duplicate", count: duplicate_rows})
        |> add_missing_issues(rows, required_fields)
        |> maybe_add(stale_rows > 0, %{type: "stale", count: stale_rows})
        |> Kernel.++(outlier_issues)

      quality_score = compute_score(duplicate_rows, missing_rows, stale_rows, outlier_rows)

      {:ok, %{
        passed: issues == [],
        quality_score: quality_score,
        issues: issues,
        stats: %{
          total_rows: length(rows),
          duplicate_rows: duplicate_rows,
          missing_rows: missing_rows,
          stale_rows: stale_rows,
          outlier_rows: outlier_rows
        }
      }}
    end
  end

  defp count_duplicates(rows) do
    fingerprints = Enum.map(rows, &Jason.encode!/1)
    total = length(fingerprints)
    unique = fingerprints |> Enum.uniq() |> length()
    total - unique
  end

  defp count_missing(rows, fields) do
    Enum.reduce(fields, 0, fn field, acc ->
      count = Enum.count(rows, fn row -> missing_value?(field_value(row, field)) end)
      acc + count
    end)
  end

  defp add_missing_issues(issues, rows, fields) do
    Enum.reduce(fields, issues, fn field, acc ->
      count = Enum.count(rows, fn row -> missing_value?(field_value(row, field)) end)
      if count > 0, do: acc ++ [%{type: "missing_required", field: field, count: count}], else: acc
    end)
  end

  defp count_stale(_rows, nil, _days), do: 0
  defp count_stale(rows, freshness_field, threshold_days) do
    now_ms = System.system_time(:millisecond)
    max_age_ms = threshold_days * 24 * 60 * 60 * 1000
    Enum.count(rows, fn row ->
      val = field_value(row, freshness_field)
      case to_timestamp(val) do
        nil -> true
        ts -> now_ms - ts > max_age_ms
      end
    end)
  end

  defp to_timestamp(nil), do: nil
  defp to_timestamp(val) when is_integer(val), do: val
  defp to_timestamp(val) when is_binary(val) do
    case DateTime.from_iso8601(val) do
      {:ok, dt, _} -> DateTime.to_unix(dt, :millisecond)
      _ -> nil
    end
  end
  defp to_timestamp(_), do: nil

  defp count_outliers(_rows, []), do: {0, []}
  defp count_outliers(rows, numeric_fields) do
    Enum.reduce(numeric_fields, {0, []}, fn field, {total_count, all_issues} ->
      values =
        rows
        |> Enum.map(fn row -> field_value(row, field) end)
        |> Enum.flat_map(fn
          v when is_number(v) -> [v * 1.0]
          v when is_binary(v) ->
            case Float.parse(v) do
              {f, ""} -> [f]
              _ -> []
            end
          _ -> []
        end)

      case median(values) do
        nil ->
          {total_count, all_issues}
        med ->
          threshold = max(10.0, abs(med) * 5.0)
          count = Enum.count(rows, fn row ->
            val = field_value(row, field)
            is_number(val) and abs(val - med) > threshold
          end)
          if count > 0 do
            issue = %{type: "outlier", field: field, count: count, baseline: Float.round(med, 2)}
            {total_count + count, all_issues ++ [issue]}
          else
            {total_count, all_issues}
          end
      end
    end)
  end

  defp median([]), do: nil
  defp median(values) do
    sorted = Enum.sort(values)
    len = length(sorted)
    mid = div(len, 2)
    if rem(len, 2) == 0 do
      (Enum.at(sorted, mid - 1) + Enum.at(sorted, mid)) / 2.0
    else
      Enum.at(sorted, mid) * 1.0
    end
  end

  defp compute_score(duplicates, missing, stale, outliers) do
    score = 10.0 - duplicates * 0.6 - missing * 0.8 - stale * 0.7 - outliers * 0.4
    max(0.0, Float.round(score, 1))
  end

  defp missing_value?(nil), do: true
  defp missing_value?(""), do: true
  defp missing_value?(_), do: false

  defp field_value(row, field) when is_map(row) do
    case Map.fetch(row, field) do
      {:ok, value} -> value
      :error -> field_value_from_alias(row, field)
    end
  end

  defp field_value(_row, _field), do: nil

  defp field_value_from_alias(row, field) when is_atom(field), do: Map.get(row, Atom.to_string(field))

  defp field_value_from_alias(row, field) when is_binary(field) do
    try do
      Map.get(row, String.to_existing_atom(field))
    rescue
      ArgumentError -> nil
    end
  end

  defp field_value_from_alias(_row, _field), do: nil

  defp maybe_add(list, false, _item), do: list
  defp maybe_add(list, true, item), do: list ++ [item]
end
