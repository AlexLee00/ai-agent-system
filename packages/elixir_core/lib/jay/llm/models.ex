defmodule Jay.Core.LLM.Models do
  @moduledoc """
  LLM 모델 단일 소스 — packages/core/lib/llm-models.json 읽음.
  모델 문자열 하드코딩 제거를 위한 중앙 레지스트리.
  """

  @config_path Path.expand(
    Path.join([__DIR__, "..", "..", "..", "..", "core", "lib", "llm-models.json"])
  )

  @doc "추상 모델명 → 실제 Claude 모델 ID."
  def get_current("anthropic_haiku"),  do: "claude-haiku-4-5-20251001"
  def get_current("anthropic_sonnet"), do: "claude-sonnet-4-6"
  def get_current("anthropic_opus"),   do: "claude-opus-4-7"
  def get_current(_),                  do: "claude-haiku-4-5-20251001"

  @doc "추상 모델명 → Groq 폴백 모델 ID."
  def get_groq_fallback("anthropic_haiku"),  do: "llama-3.1-8b-instant"
  def get_groq_fallback("anthropic_sonnet"), do: "llama-3.3-70b-versatile"
  def get_groq_fallback("anthropic_opus"),   do: "qwen-qwq-32b"
  def get_groq_fallback(_),                  do: "llama-3.3-70b-versatile"

  @doc "토큰 비용 계산 (USD)."
  def get_cost("anthropic_haiku", tokens_in, tokens_out) do
    tokens_in * 0.8 / 1_000_000 + tokens_out * 4.0 / 1_000_000
  end
  def get_cost("anthropic_sonnet", tokens_in, tokens_out) do
    tokens_in * 3.0 / 1_000_000 + tokens_out * 15.0 / 1_000_000
  end
  def get_cost("anthropic_opus", tokens_in, tokens_out) do
    tokens_in * 15.0 / 1_000_000 + tokens_out * 75.0 / 1_000_000
  end
  def get_cost(_, _, _), do: 0.0

  @doc "지원 추상 모델 목록."
  def abstract_models, do: ["anthropic_haiku", "anthropic_sonnet", "anthropic_opus"]

  @doc "JSON 설정 전체 로드 (런타임 참조용)."
  def load_config do
    if File.exists?(@config_path) do
      File.read!(@config_path) |> Jason.decode!()
    else
      %{"models" => %{}, "groq_fallback_models" => %{}}
    end
  end
end
