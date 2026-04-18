defmodule Darwin.V2.Config do
  @moduledoc """
  다윈팀 V2 Kill Switch + 환경 설정.

  모든 Kill Switch는 기본값 false (단계적 활성화).
  DARWIN_V2_ENABLED=true → 전체 V2 기능 게이트.
  """

  @doc """
  다윈 V2 전체 활성화 여부.
  환경변수: DARWIN_V2_ENABLED (기본 false)
  """
  def v2_enabled? do
    System.get_env("DARWIN_V2_ENABLED", "false") == "true"
  end

  @doc """
  Darwin V2 kill switch 상태.
  환경변수: DARWIN_KILL_SWITCH (기본 true)
  """
  def kill_switch? do
    System.get_env("DARWIN_KILL_SWITCH", "true") == "true"
  end

  @doc """
  Darwin.V2.LLM.Selector 활성화 여부.
  환경변수: DARWIN_LLM_SELECTOR_ENABLED (기본 false)
  v2_enabled? AND DARWIN_LLM_SELECTOR_ENABLED=true 모두 필요.
  """
  def llm_selector_enabled? do
    v2_enabled?() and
      System.get_env("DARWIN_LLM_SELECTOR_ENABLED", "false") == "true"
  end

  @doc """
  Shadow Mode 활성화 여부 (L3 병행 검증).
  환경변수: DARWIN_SHADOW_MODE_ENABLED (기본 false)
  """
  def shadow_mode_enabled? do
    v2_enabled?() and
      System.get_env("DARWIN_SHADOW_MODE_ENABLED", "false") == "true"
  end

  @doc """
  운영 shadow mode 활성 상태.
  DARWIN_SHADOW_MODE 또는 DARWIN_SHADOW_ENABLED 둘 중 하나라도 true면 활성.
  """
  def shadow_mode_active? do
    System.get_env("DARWIN_SHADOW_MODE", "false") == "true" or
      System.get_env("DARWIN_SHADOW_ENABLED", "false") == "true" or
      shadow_mode_enabled?()
  end

  @doc """
  ESPL 활성화 여부.
  환경변수: DARWIN_ESPL_ENABLED (기본 false)
  """
  def espl_enabled? do
    v2_enabled?() and
      System.get_env("DARWIN_ESPL_ENABLED", "false") == "true"
  end

  @doc """
  Reflexion 자기 개선 루프 활성화.
  환경변수: DARWIN_REFLEXION_ENABLED (기본 false)
  """
  def reflexion_enabled? do
    v2_enabled?() and
      System.get_env("DARWIN_REFLEXION_ENABLED", "false") == "true"
  end

  @doc """
  Self-RAG 컨텍스트 검색 활성화.
  환경변수: DARWIN_SELF_RAG_ENABLED (기본 false)
  """
  def self_rag_enabled? do
    v2_enabled?() and
      System.get_env("DARWIN_SELF_RAG_ENABLED", "false") == "true"
  end

  @doc """
  Tier 2 자동 적용 활성화 (L4+ 자율 배포).
  환경변수: DARWIN_TIER2_AUTO_APPLY (기본 false — Shadow 7일 관찰 후 활성화)
  """
  def tier2_auto_apply? do
    v2_enabled?() and
      System.get_env("DARWIN_TIER2_AUTO_APPLY", "false") == "true"
  end

  @doc """
  MCP Server 활성화.
  환경변수: DARWIN_MCP_SERVER_ENABLED (기본 false)
  """
  def mcp_server_enabled? do
    v2_enabled?() and
      System.get_env("DARWIN_MCP_SERVER_ENABLED", "false") == "true"
  end

  @doc """
  Darwin HTTP 포트.
  환경변수: DARWIN_HTTP_PORT (기본 8180)
  """
  def http_port do
    System.get_env("DARWIN_HTTP_PORT", "8180")
    |> String.to_integer()
  end

  @doc """
  일일 LLM 예산 (USD).
  환경변수: DARWIN_LLM_DAILY_BUDGET_USD (기본 5.0)
  """
  def daily_budget_usd do
    System.get_env("DARWIN_LLM_DAILY_BUDGET_USD", "5.0")
    |> String.to_float()
  end

  @doc """
  Anthropic API 키.
  """
  def anthropic_api_key do
    System.get_env("ANTHROPIC_API_KEY") || System.get_env("DARWIN_ANTHROPIC_API_KEY")
  end

  @doc """
  MLX base URL.
  """
  def mlx_base_url do
    System.get_env("MLX_BASE_URL", "http://localhost:11434")
  end

  @doc """
  Darwin 로컬 fast 모델명.
  """
  def local_model_fast do
    System.get_env("LOCAL_MODEL_FAST", "qwen2.5-7b")
  end

  @doc """
  Darwin 로컬 deep 모델명.
  """
  def local_model_deep do
    System.get_env("LOCAL_MODEL_DEEP", "deepseek-r1-32b")
  end

  @doc """
  현재 활성화된 Kill Switch 상태 요약.
  """
  def status do
    %{
      v2_enabled:            v2_enabled?(),
      kill_switch:           kill_switch?(),
      llm_selector_enabled:  llm_selector_enabled?(),
      shadow_mode_enabled:   shadow_mode_active?(),
      espl_enabled:          espl_enabled?(),
      reflexion_enabled:     reflexion_enabled?(),
      self_rag_enabled:      self_rag_enabled?(),
      tier2_auto_apply:      tier2_auto_apply?(),
      mcp_server_enabled:    mcp_server_enabled?(),
      daily_budget_usd:      daily_budget_usd(),
      http_port:             http_port(),
      mlx_base_url:          mlx_base_url(),
      local_model_fast:      local_model_fast(),
      local_model_deep:      local_model_deep()
    }
  end
end
