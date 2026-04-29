defmodule Darwin.V2.KillSwitch do
  @moduledoc """
  다윈 V2 Kill Switch — 단계적 활성화/비활성화 제어.

  환경변수 기반:
    DARWIN_V2_ENABLED=true         → V2 전체 기동
    DARWIN_CYCLE_ENABLED=true      → 7단계 자율 사이클 기동
    DARWIN_SHADOW_ENABLED=true     → Shadow Mode 활성화
    DARWIN_L5_ENABLED=true         → L5 완전자율 허용
    DARWIN_MCP_ENABLED=true        → MCP Server 활성화
    DARWIN_ESPL_ENABLED=true       → ESPL 진화 루프 활성화
    DARWIN_SELF_RAG_ENABLED=true   → SelfRAG 4-gate 활성화
  """

  use GenServer
  require Logger

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "특정 기능이 활성화돼 있는지 확인."
  @spec enabled?(atom()) :: boolean()
  def enabled?(feature) do
    env_key = feature_env(feature)
    System.get_env(env_key) == "true"
  end

  @doc "현재 활성화된 기능 목록 반환."
  @spec active_features() :: [atom()]
  def active_features do
    Enum.filter(all_features(), &enabled?/1)
  end

  @impl GenServer
  def init(_opts) do
    active = active_features()
    Logger.info("[darwin/kill_switch] 활성 기능: #{inspect(active)}")
    {:ok, %{active: active, started_at: DateTime.utc_now()}}
  end

  # ---

  defp all_features do
    [
      :v2, :cycle, :shadow, :l5, :mcp, :espl, :self_rag,
      # Phase R 신규
      :mapek,
      # Phase S 신규
      :self_rewarding,
      # Phase A 신규
      :agentic_rag,
      # Phase K 신규
      :research_registry,
      # Phase O 신규
      :telegram_enhanced,
      # 자율 레벨 승격 관련
      :auto_promotion,
      # CODEX Phase A — 9 팀 통합
      :team_integration,
      # CODEX Phase B — Hypothesis Engine (Sakana AI Scientist)
      :hypothesis_engine,
      # CODEX Phase C — Measure Stage
      :measure_stage
    ]
  end

  defp feature_env(:v2), do: "DARWIN_V2_ENABLED"
  defp feature_env(:cycle), do: "DARWIN_CYCLE_ENABLED"
  defp feature_env(:shadow), do: "DARWIN_SHADOW_ENABLED"
  defp feature_env(:l5), do: "DARWIN_L5_ENABLED"
  defp feature_env(:mcp), do: "DARWIN_MCP_ENABLED"
  defp feature_env(:espl), do: "DARWIN_ESPL_ENABLED"
  defp feature_env(:self_rag), do: "DARWIN_SELF_RAG_ENABLED"
  # Phase R~O 신규
  defp feature_env(:mapek), do: "DARWIN_MAPEK_ENABLED"
  defp feature_env(:self_rewarding), do: "DARWIN_SELF_REWARDING_ENABLED"
  defp feature_env(:agentic_rag), do: "DARWIN_AGENTIC_RAG_ENABLED"
  defp feature_env(:research_registry), do: "DARWIN_RESEARCH_REGISTRY_ENABLED"
  defp feature_env(:telegram_enhanced), do: "DARWIN_TELEGRAM_ENHANCED_ENABLED"
  defp feature_env(:auto_promotion), do: "DARWIN_AUTO_PROMOTION_ENABLED"
  # CODEX Phase A/B/C
  defp feature_env(:team_integration), do: "DARWIN_TEAM_INTEGRATION_ENABLED"
  defp feature_env(:hypothesis_engine), do: "DARWIN_HYPOTHESIS_ENGINE_ENABLED"
  defp feature_env(:measure_stage), do: "DARWIN_MEASURE_STAGE_ENABLED"
  defp feature_env(other), do: "DARWIN_#{String.upcase(to_string(other))}_ENABLED"
end
