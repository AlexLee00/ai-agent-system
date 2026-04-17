defmodule Sigma.V2.E2ETest do
  use ExUnit.Case, async: false

  @moduletag :e2e

  describe "MCP Server — list_tools + call_tool" do
    test "list_tools returns 5 tools" do
      tools = Sigma.V2.MCP.Server.list_tools()
      assert length(tools) == 5

      names = Enum.map(tools, & &1.name)
      assert "data_quality_guard" in names
      assert "causal_check" in names
      assert "experiment_design" in names
      assert "feature_planner" in names
      assert "observability_planner" in names
    end

    test "call_tool data_quality_guard — valid rows" do
      params = %{
        "rows" => [
          %{"id" => 1, "name" => "Alice", "score" => 85},
          %{"id" => 2, "name" => "Bob", "score" => 90}
        ],
        "required_fields" => ["id", "name"]
      }

      assert {:ok, result} = Sigma.V2.MCP.Server.call_tool("data_quality_guard", params)
      assert result.passed == true
      assert result.quality_score >= 0
      assert is_list(result.issues)
    end

    test "call_tool causal_check — high risk case" do
      params = %{
        "claim" => "상관관계가 인과관계를 의미한다",
        "correlation" => 0.95,
        "controls" => [],
        "confounders" => ["market_condition"],
        "sample_size" => 10
      }

      assert {:ok, result} = Sigma.V2.MCP.Server.call_tool("causal_check", params)
      assert result.causal_risk == "high"
      assert length(result.flags) >= 2
    end

    test "call_tool experiment_design — complete design" do
      params = %{
        "hypothesis" => "블로그 제목 A/B 테스트 시 CTR이 10% 이상 증가할 것이다",
        "primary_metric" => "ctr",
        "baseline" => 0.035,
        "variants" => ["control", "variant_a"],
        "min_detectable_effect" => 0.10,
        "guardrails" => ["bounce_rate"]
      }

      assert {:ok, result} = Sigma.V2.MCP.Server.call_tool("experiment_design", params)
      assert is_number(result.design_score)
      assert result.design_score >= 0
    end

    test "call_tool feature_planner — ranks and classifies" do
      params = %{
        "features" => [
          %{"name" => "auto_title", "signal" => 4, "effort" => 2, "leakage_risk" => 0},
          %{"name" => "risky_ml", "signal" => 5, "effort" => 1, "leakage_risk" => 5}
        ]
      }

      assert {:ok, result} = Sigma.V2.MCP.Server.call_tool("feature_planner", params)
      assert is_list(result.ranked_features)
      assert "risky_ml" in Enum.map(result.high_risk_features, & &1.name)
      assert "auto_title" in Enum.map(result.quick_wins, & &1.name)
    end

    test "call_tool observability_planner — returns recommendations" do
      params = %{
        "service" => "sigma",
        "existing_metrics" => ["latency_p99"],
        "alert_channels" => ["telegram"]
      }

      assert {:ok, result} = Sigma.V2.MCP.Server.call_tool("observability_planner", params)
      assert is_list(result.recommended_metrics)
      assert is_number(result.coverage_score)
    end

    test "call_tool unknown tool returns error" do
      assert {:error, :unknown_tool} = Sigma.V2.MCP.Server.call_tool("nonexistent", %{})
    end
  end

  describe "MCP Auth Plug" do
    test "valid token passes" do
      System.put_env("SIGMA_MCP_TOKEN", "test-token-e2e")

      conn =
        Plug.Test.conn(:get, "/mcp/sigma/tools")
        |> Plug.Conn.put_req_header("authorization", "Bearer test-token-e2e")

      result = Sigma.V2.MCP.Auth.call(conn, [])
      refute result.halted
    end

    test "missing token returns 401" do
      System.put_env("SIGMA_MCP_TOKEN", "test-token-e2e")

      conn = Plug.Test.conn(:get, "/mcp/sigma/tools")
      result = Sigma.V2.MCP.Auth.call(conn, [])

      assert result.halted
      assert result.status == 401
    end

    test "wrong token returns 401" do
      System.put_env("SIGMA_MCP_TOKEN", "test-token-e2e")

      conn =
        Plug.Test.conn(:get, "/mcp/sigma/tools")
        |> Plug.Conn.put_req_header("authorization", "Bearer wrong-token")

      result = Sigma.V2.MCP.Auth.call(conn, [])
      assert result.halted
      assert result.status == 401
    end

    test "empty SIGMA_MCP_TOKEN env returns 401" do
      System.put_env("SIGMA_MCP_TOKEN", "")

      conn =
        Plug.Test.conn(:get, "/mcp/sigma/tools")
        |> Plug.Conn.put_req_header("authorization", "Bearer anything")

      result = Sigma.V2.MCP.Auth.call(conn, [])
      assert result.halted
      assert result.status == 401
    end
  end

  describe "DataQualityGuard — 스킬 단독 직접 호출" do
    test "empty rows returns passed: false, score: 0" do
      assert {:ok, %{passed: false, quality_score: 0}} =
               Sigma.V2.Skill.DataQualityGuard.run(%{rows: []}, %{})
    end

    test "duplicate rows detected" do
      row = %{id: 1, name: "Alice"}

      assert {:ok, result} =
               Sigma.V2.Skill.DataQualityGuard.run(
                 %{rows: [row, row]},
                 %{}
               )

      dup_issue = Enum.find(result.issues, &(&1.type == "duplicate"))
      assert dup_issue != nil
      assert dup_issue.count == 1
    end
  end

  describe "FeaturePlanner — 분류 정확성" do
    test "high_risk feature with leakage_risk >= 4" do
      params = %{
        features: [%{name: "danger_feature", signal: 5, effort: 1, leakage_risk: 4}]
      }

      assert {:ok, result} = Sigma.V2.Skill.FeaturePlanner.run(params, %{})
      assert length(result.high_risk_features) == 1
    end

    test "quick_win with score >= 3 and effort <= 2" do
      params = %{
        features: [%{name: "easy_win", signal: 4, effort: 2, leakage_risk: 0}]
      }

      assert {:ok, result} = Sigma.V2.Skill.FeaturePlanner.run(params, %{})
      assert "easy_win" in Enum.map(result.quick_wins, & &1.name)
    end
  end
end
