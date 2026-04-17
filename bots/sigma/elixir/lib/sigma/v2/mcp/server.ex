defmodule Sigma.V2.MCP.Server do
  @moduledoc """
  Sigma MCP Server — agentskills.io 오픈 표준 준수.
  Claude Code + Claude.ai + Claude API 어디서든 호출 가능.
  """

  # MCP tool discovery — L0 이름만 응답 (Progressive Disclosure)
  def list_tools do
    [
      %{
        name: "data_quality_guard",
        description: "Evaluate dataset for duplicates/missing/stale/outliers",
        inputSchema: %{
          type: "object",
          required: ["rows"],
          properties: %{
            rows: %{type: "array", description: "데이터 로우 목록"},
            required_fields: %{type: "array", items: %{type: "string"}, description: "필수 필드 목록"},
            freshness_field: %{type: "string", description: "신선도 체크 필드명"},
            freshness_threshold_days: %{type: "integer", default: 7, description: "신선도 임계일"},
            numeric_fields: %{type: "array", items: %{type: "string"}, description: "이상값 체크 수치 필드"}
          }
        }
      },
      %{
        name: "causal_check",
        description: "Check causal validity of proposed feedback before application",
        inputSchema: %{
          type: "object",
          properties: %{
            claim: %{type: "string", description: "검증할 인과 주장"},
            correlation: %{type: "number", default: 0.0, description: "관측된 상관계수"},
            controls: %{type: "array", items: %{type: "string"}, description: "통제변수 목록"},
            confounders: %{type: "array", items: %{type: "string"}, description: "혼재변수 목록"},
            sample_size: %{type: "integer", default: 0, description: "샘플 크기"}
          }
        }
      },
      %{
        name: "experiment_design",
        description: "Design A/B experiment with hypothesis, metrics, sample size, and guardrails",
        inputSchema: %{
          type: "object",
          properties: %{
            hypothesis: %{type: "string", description: "검증 가설"},
            primary_metric: %{type: "string", description: "1차 성과 지표"},
            baseline: %{type: "number", description: "현재 기준값"},
            variants: %{type: "array", items: %{type: "string"}, description: "실험 변종 목록"},
            min_detectable_effect: %{type: "number", description: "최소 감지 효과 크기"}
          }
        }
      },
      %{
        name: "feature_planner",
        description: "Prioritize features by signal/effort/leakage-risk score",
        inputSchema: %{
          type: "object",
          required: ["features"],
          properties: %{
            features: %{
              type: "array",
              description: "피처 후보 목록",
              items: %{
                type: "object",
                properties: %{
                  name: %{type: "string"},
                  signal: %{type: "number", description: "예상 신호 강도 (0~5)"},
                  effort: %{type: "number", description: "구현 난이도 (0~5)"},
                  leakage_risk: %{type: "number", description: "데이터 리크 위험도 (0~5)"}
                }
              }
            }
          }
        }
      },
      %{
        name: "observability_planner",
        description: "Plan OTel observability: metrics, alerts, anomaly detection",
        inputSchema: %{
          type: "object",
          properties: %{
            service: %{type: "string", description: "서비스명"},
            existing_metrics: %{type: "array", items: %{type: "string"}, description: "기존 메트릭 목록"},
            alert_channels: %{type: "array", items: %{type: "string"}, description: "알람 채널 목록"}
          }
        }
      }
    ]
  end

  # MCP tool invocation — L1 full action 호출
  def call_tool(name, params) do
    atom_params = atomize_keys(params)

    case name do
      "data_quality_guard" ->
        Sigma.V2.Skill.DataQualityGuard.run(atom_params, %{})

      "causal_check" ->
        Sigma.V2.Skill.CausalCheck.run(atom_params, %{})

      "experiment_design" ->
        Sigma.V2.Skill.ExperimentDesign.run(atom_params, %{})

      "feature_planner" ->
        Sigma.V2.Skill.FeaturePlanner.run(atom_params, %{})

      "observability_planner" ->
        Sigma.V2.Skill.ObservabilityPlanner.run(atom_params, %{})

      _ ->
        {:error, :unknown_tool}
    end
  end

  defp atomize_keys(map) when is_map(map) do
    Map.new(map, fn
      {k, v} when is_binary(k) -> {String.to_atom(k), atomize_keys(v)}
      {k, v} -> {k, atomize_keys(v)}
    end)
  end

  defp atomize_keys(list) when is_list(list), do: Enum.map(list, &atomize_keys/1)
  defp atomize_keys(v), do: v
end
