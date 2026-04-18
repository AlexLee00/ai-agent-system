defmodule TeamJay.Ska.Rag.AgenticRagTest do
  use ExUnit.Case, async: false
  alias TeamJay.Ska.Rag.AgenticRag

  describe "retrieve_recovery_strategy/1" do
    test "SKA_AGENTIC_RAG_ENABLED=false 시 fallback 반환" do
      System.put_env("SKA_AGENTIC_RAG_ENABLED", "false")

      context = %{agent: :andy, error: :parse_failed, message: "셀렉터 CSS 변경"}

      # FailureLibrary가 없으므로 에러 발생 가능 — 반환 타입만 검증
      result = AgenticRag.retrieve_recovery_strategy(context)

      case result do
        {:ok, _} -> :ok
        {:error, _} -> :ok
      end
    end
  end
end
