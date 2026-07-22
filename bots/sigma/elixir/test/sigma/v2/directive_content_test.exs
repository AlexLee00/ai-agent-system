defmodule Sigma.V2.DirectiveContentTest do
  use ExUnit.Case, async: true

  alias Sigma.Directive.ApplyFeedback
  alias Sigma.V2.Archivist
  alias Sigma.V2.DirectiveContent

  @feedback %{
    target_team: "luna",
    feedback_type: "general_review",
    content: "거래 운영 지표를 점검하고 임계 이탈 시 다음 조치를 보고하세요.",
    before_metric: %{
      metric_type: "trading_ops",
      trades_7d: 4,
      traded_usdt_7d: 1250.5,
      live_positions: 2
    }
  }

  test "builds a versioned directive with explicit KPI thresholds and reporting contract" do
    action = DirectiveContent.build(@feedback)

    assert action.schema_version == "sigma.directive.v1"
    assert action.target_team == "luna"
    assert action.owner == "luna"
    assert action.feedback_type == "general_review"
    assert is_binary(action.purpose) and action.purpose != ""
    assert action.content == action.purpose
    assert action.cadence == %{measure_every: "P1D", report_every: "P1D"}
    assert action.report_format.format == "markdown"

    assert action.report_format.required_sections == [
             "kpi_snapshot",
             "threshold_breaches",
             "next_actions"
           ]

    assert Enum.map(action.kpis, & &1.name) == ["trades_7d", "traded_usdt_7d", "live_positions"]

    assert Enum.all?(action.kpis, fn kpi ->
             is_number(kpi.current_value) and
               kpi.threshold.operator in [">=", "<="] and
               is_number(kpi.threshold.value)
           end)
  end

  test "same feedback is stable while a current KPI change changes the directive meaning" do
    first = DirectiveContent.build(@feedback)
    repeated = DirectiveContent.build(@feedback)
    changed = DirectiveContent.build(put_in(@feedback, [:before_metric, :trades_7d], 5))

    assert first == repeated
    refute first == changed
  end

  test "repeat lookup is SELECT-only and compares the latest matching semantic action" do
    action = DirectiveContent.build(@feedback)

    directive = %ApplyFeedback{
      team: "luna",
      tier: 1,
      action: action,
      rollback_spec: %{mode: "advisory_only"}
    }

    query = fn sql, params ->
      assert sql =~ "SELECT"
      assert sql =~ "outcome = 'signal_sent'"
      assert sql =~ "action = $3::jsonb"
      assert sql =~ "executed_at >= NOW()"
      refute sql =~ ~r/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i
      assert ["luna", "general_review", encoded, 24] = params
      assert Jason.decode!(encoded)["target_team"] == "luna"
      {:ok, %{rows: [[true]]}}
    end

    assert Archivist.signal_already_sent?(directive, query: query)
  end

  test "repeat lookup fails closed when the audit read fails" do
    directive = %ApplyFeedback{
      team: "luna",
      tier: 1,
      action: DirectiveContent.build(@feedback),
      rollback_spec: %{mode: "advisory_only"}
    }

    assert Archivist.signal_already_sent?(directive,
             query: fn _sql, _params -> {:error, :db_down} end
           )

    assert Archivist.signal_already_sent?(directive,
             query: fn _sql, _params -> raise "db_down" end
           )
  end

  test "recent signals bind a DateTime and serialize Postgrex UUIDs" do
    uuid = Ecto.UUID.generate()
    {:ok, dumped_uuid} = Ecto.UUID.dump(uuid)

    query = fn sql, [team, since] ->
      assert sql =~ "$2::timestamptz"
      assert team == "luna"
      assert %DateTime{} = since

      {:ok,
       %{
         columns: ["directive_id", "action", "executed_at", "outcome", "principle_check_result"],
         rows: [[dumped_uuid, %{}, ~U[2026-07-07 00:00:00Z], "signal_sent", %{}]]
       }}
    end

    assert [%{directive_id: ^uuid}] =
             Archivist.recent_signals("luna", "2026-07-06T00:00:00Z", query: query)
  end
end
