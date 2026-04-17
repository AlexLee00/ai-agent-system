defmodule Sigma.V2.Skill.DataQualityGuardTest do
  use ExUnit.Case, async: true

  alias Sigma.V2.Skill.DataQualityGuard

  defp run(params) do
    DataQualityGuard.run(params, %{})
  end

  test "empty dataset returns failed with score 0" do
    {:ok, result} = run(%{rows: [], required_fields: [], freshness_threshold_days: 7, numeric_fields: []})
    assert result.passed == false
    assert result.quality_score == 0
    assert [%{type: "empty_dataset"}] = result.issues
    assert result.stats.total_rows == 0
  end

  test "clean dataset passes with score 10.0" do
    rows = [
      %{id: 1, name: "alice", value: 100},
      %{id: 2, name: "bob", value: 110},
      %{id: 3, name: "carol", value: 105}
    ]
    {:ok, result} = run(%{
      rows: rows,
      required_fields: ["name"],
      freshness_threshold_days: 7,
      numeric_fields: []
    })
    assert result.passed == true
    assert result.quality_score == 10.0
    assert result.issues == []
    assert result.stats.total_rows == 3
    assert result.stats.duplicate_rows == 0
    assert result.stats.missing_rows == 0
  end

  test "detects duplicates and reduces score" do
    row = %{id: 1, name: "dup"}
    rows = [row, row, %{id: 2, name: "unique"}]
    {:ok, result} = run(%{rows: rows, required_fields: [], freshness_threshold_days: 7, numeric_fields: []})
    assert result.stats.duplicate_rows == 1
    assert Enum.any?(result.issues, &(&1.type == "duplicate"))
    assert result.quality_score < 10.0
  end

  test "detects missing required fields" do
    rows = [
      %{id: 1, name: "alice"},
      %{id: 2},
      %{id: 3, name: ""}
    ]
    {:ok, result} = run(%{rows: rows, required_fields: ["name"], freshness_threshold_days: 7, numeric_fields: []})
    assert result.stats.missing_rows == 2
    assert Enum.any?(result.issues, &(&1.type == "missing_required"))
    assert result.passed == false
    assert result.quality_score < 10.0
  end

  test "detects stale rows based on freshness field" do
    now = DateTime.utc_now()
    old = DateTime.add(now, -10 * 86400, :second) |> DateTime.to_iso8601()
    fresh = DateTime.add(now, -1 * 86400, :second) |> DateTime.to_iso8601()
    rows = [
      %{id: 1, updated_at: old},
      %{id: 2, updated_at: fresh}
    ]
    {:ok, result} = run(%{
      rows: rows,
      required_fields: [],
      freshness_field: "updated_at",
      freshness_threshold_days: 7,
      numeric_fields: []
    })
    assert result.stats.stale_rows == 1
    assert Enum.any?(result.issues, &(&1.type == "stale"))
  end

  test "detects outliers in numeric field" do
    rows = Enum.map(1..10, &%{val: &1 * 10.0}) ++ [%{val: 9999.0}]
    {:ok, result} = run(%{rows: rows, required_fields: [], freshness_threshold_days: 7, numeric_fields: ["val"]})
    assert result.stats.outlier_rows >= 1
    assert Enum.any?(result.issues, &(&1.type == "outlier"))
  end

  test "quality score formula matches TS: score = 10 - dup*0.6 - missing*0.8 - stale*0.7 - outlier*0.4" do
    rows = [%{a: 1}, %{a: 1}, %{b: 2}]
    {:ok, result} = run(%{rows: rows, required_fields: [], freshness_threshold_days: 7, numeric_fields: []})
    expected = Float.round(10.0 - 1 * 0.6, 1)
    assert result.quality_score == expected
  end
end
