defmodule Sigma.V2.KillSwitch do
  @moduledoc """
  시그마팀 Kill Switch 중앙 레지스트리.

  모든 기능 플래그를 한 곳에 모아 관리.
  기본값은 모두 false (명시적 활성화 필요).

  환경변수 → 기능 매핑:
    SIGMA_V2_ENABLED            → v2_enabled?/0
    SIGMA_MAPEK_ENABLED         → mapek_enabled?/0       (Phase R)
    SIGMA_SELF_REWARDING_ENABLED → self_rewarding_enabled?/0  (Phase S)
    SIGMA_AGENTIC_RAG_ENABLED   → agentic_rag_enabled?/0  (Phase A)
    SIGMA_TELEGRAM_ENHANCED     → telegram_enhanced?/0    (Phase O)
    SIGMA_POD_DYNAMIC_V2_ENABLED → pod_dynamic_v2_enabled?/0 (Phase P)
  """

  @doc "Sigma V2 전체 기동 여부."
  def v2_enabled? do
    System.get_env("SIGMA_V2_ENABLED") == "true"
  end

  @doc "MAPE-K 자율 루프 활성화 여부 (Phase R)."
  def mapek_enabled? do
    v2_enabled?() and System.get_env("SIGMA_MAPEK_ENABLED") == "true"
  end

  @doc "Self-Rewarding DPO 평가 활성화 여부 (Phase S)."
  def self_rewarding_enabled? do
    v2_enabled?() and System.get_env("SIGMA_SELF_REWARDING_ENABLED") == "true"
  end

  @doc "Agentic RAG 4 모듈 활성화 여부 (Phase A)."
  def agentic_rag_enabled? do
    v2_enabled?() and System.get_env("SIGMA_AGENTIC_RAG_ENABLED") == "true"
  end

  @doc "Telegram 5채널 강화 리포트 활성화 여부 (Phase O)."
  def telegram_enhanced? do
    System.get_env("SIGMA_TELEGRAM_ENHANCED") == "true"
  end

  @doc "Pod 동적 편성 v2 (UCB1 + Thompson + Contextual) 활성화 여부 (Phase P)."
  def pod_dynamic_v2_enabled? do
    v2_enabled?() and System.get_env("SIGMA_POD_DYNAMIC_V2_ENABLED") == "true"
  end
end
