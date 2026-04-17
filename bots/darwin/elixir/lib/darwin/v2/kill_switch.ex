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
    [:v2, :cycle, :shadow, :l5, :mcp, :espl, :self_rag]
  end

  defp feature_env(:v2), do: "DARWIN_V2_ENABLED"
  defp feature_env(:cycle), do: "DARWIN_CYCLE_ENABLED"
  defp feature_env(:shadow), do: "DARWIN_SHADOW_ENABLED"
  defp feature_env(:l5), do: "DARWIN_L5_ENABLED"
  defp feature_env(:mcp), do: "DARWIN_MCP_ENABLED"
  defp feature_env(:espl), do: "DARWIN_ESPL_ENABLED"
  defp feature_env(:self_rag), do: "DARWIN_SELF_RAG_ENABLED"
  defp feature_env(other), do: "DARWIN_#{String.upcase(to_string(other))}_ENABLED"
end
