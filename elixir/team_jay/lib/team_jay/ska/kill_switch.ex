defmodule TeamJay.Ska.KillSwitch do
  @moduledoc """
  스카팀 Kill Switch 중앙 레지스트리.

  모든 실험적 기능의 활성화 여부를 한 곳에서 관리.
  환경변수 기반으로 런타임에 즉시 변경 가능.

  사용법:
    TeamJay.Ska.KillSwitch.skill_registry_enabled?()   # 기본 true
    TeamJay.Ska.KillSwitch.mapek_enabled?()             # 기본 false
    TeamJay.Ska.KillSwitch.self_rewarding_enabled?()    # 기본 false
    TeamJay.Ska.KillSwitch.agentic_rag_enabled?()       # 기본 false
    TeamJay.Ska.KillSwitch.python_skill_enabled?()      # 기본 false
    TeamJay.Ska.KillSwitch.naver_skill_enabled?()       # 기본 false
  """

  @doc "Skill Registry 활성 여부 (기본 true — 안전)"
  def skill_registry_enabled? do
    System.get_env("SKA_SKILL_REGISTRY_ENABLED", "true") == "true"
  end

  @doc "MAPE-K 자율 루프 활성 여부 (기본 false)"
  def mapek_enabled? do
    System.get_env("SKA_MAPEK_ENABLED", "false") == "true"
  end

  @doc "Self-Rewarding DPO 활성 여부 (기본 false)"
  def self_rewarding_enabled? do
    System.get_env("SKA_SELF_REWARDING_ENABLED", "false") == "true"
  end

  @doc "Agentic RAG 활성 여부 (기본 false)"
  def agentic_rag_enabled? do
    System.get_env("SKA_AGENTIC_RAG_ENABLED", "false") == "true"
  end

  @doc "Python 스킬 (forecast/rebecca/eve) 활성 여부 (기본 false)"
  def python_skill_enabled? do
    System.get_env("SKA_PYTHON_SKILL_ENABLED", "false") == "true"
  end

  @doc "NaverMonitor Skill 모드 활성 여부 (기본 false — Shadow 검증 후 전환)"
  def naver_skill_enabled? do
    System.get_env("SKA_NAVER_SKILL_ENABLED", "false") == "true"
  end

  @doc "Shadow 모드 활성 여부 — 기존+신규 병렬 실행 후 비교 (기본 true)"
  def shadow_mode_enabled? do
    System.get_env("SKA_SKILL_SHADOW_MODE", "true") == "true"
  end

  @doc "모든 Kill Switch 상태 요약"
  def status_all do
    %{
      skill_registry: skill_registry_enabled?(),
      mapek: mapek_enabled?(),
      self_rewarding: self_rewarding_enabled?(),
      agentic_rag: agentic_rag_enabled?(),
      python_skill: python_skill_enabled?(),
      naver_skill: naver_skill_enabled?(),
      shadow_mode: shadow_mode_enabled?()
    }
  end
end
