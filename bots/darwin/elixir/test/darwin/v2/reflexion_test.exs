defmodule Darwin.V2.ReflexionTest do
  use ExUnit.Case

  test "reflect/2 결과 반환 구조 검증" do
    cycle_context = %{stage: "evaluate", paper_title: "Test Paper"}
    outcome = %{score: 3, result: "low_relevance"}

    # LLM 없이도 에러 없이 실행 가능해야 함 (reflection_unavailable 반환)
    assert {:ok, entry} = Darwin.V2.Reflexion.reflect(cycle_context, outcome)
    assert is_binary(entry.reflection)
    assert entry.stage == "evaluate"
    assert is_list(entry.tags)
  end
end
