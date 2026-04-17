defmodule Darwin.V2.ReflexionTest do
  use ExUnit.Case

  @tag :integration
  test "reflect/2 결과 반환 구조 검증" do
    # reflect/2는 failure_context(%{phase:, trigger:, action:, error:})와 paper(map|nil) 수신
    failure_context = %{phase: "evaluate", trigger: :low_evaluation, action: %{}, error: "low score"}
    paper = %{title: "Test Paper", id: "1234.5678"}

    # LLM 없이도 에러 없이 실행 가능해야 함 (reflection_unavailable 반환)
    assert {:ok, entry} = Darwin.V2.Reflexion.reflect(failure_context, paper)
    assert is_binary(entry.reflection)
    assert entry.phase == "evaluate"
    assert is_list(entry.tags)
  end
end
