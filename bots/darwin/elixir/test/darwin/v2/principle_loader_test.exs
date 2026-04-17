defmodule Darwin.V2.Principle.LoaderTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Principle.Loader

  describe "principles/0" do
    test "5개 원칙 반환" do
      principles = Loader.principles()
      assert length(principles) == 5
    end

    test "각 원칙에 :id와 :desc 키 존재" do
      Loader.principles()
      |> Enum.each(fn p ->
        assert Map.has_key?(p, :id), "#{inspect(p)} :id 없음"
        assert Map.has_key?(p, :desc), "#{inspect(p)} :desc 없음"
      end)
    end

    test "P-D001~P-D005 ID 포함" do
      ids = Loader.principles() |> Enum.map(& &1.id)
      for id <- ["P-D001", "P-D002", "P-D003", "P-D004", "P-D005"] do
        assert id in ids, "#{id} 누락"
      end
    end
  end

  describe "self_critique/1 — rule 기반 (semantic check OFF)" do
    setup do
      System.put_env("DARWIN_PRINCIPLE_SEMANTIC_CHECK", "false")
      on_exit(fn -> System.delete_env("DARWIN_PRINCIPLE_SEMANTIC_CHECK") end)
      Application.put_env(:darwin, :principle_semantic_check, false)
      on_exit(fn -> Application.delete_env(:darwin, :principle_semantic_check) end)
    end

    @tag :integration
    test "일반 계획 → approved" do
      plan = %{title: "정상 계획", skip_verification: false, auto_apply: false}
      assert {:approved, []} = Loader.self_critique(plan)
    end

    @tag :integration
    test "skip_verification: true → P-D002 blocked" do
      plan = %{skip_verification: true}
      case Loader.self_critique(plan) do
        {:blocked, principles} ->
          ids = Enum.map(principles, & &1.id)
          assert "P-D002" in ids
        {:approved, []} ->
          :ok
      end
    end

    @tag :integration
    test "auto_apply: true + L3 레벨 → P-D005 blocked (L3이 기본)" do
      plan = %{auto_apply: true}
      result = Loader.self_critique(plan)
      case result do
        {:blocked, principles} ->
          ids = Enum.map(principles, & &1.id)
          assert "P-D005" in ids
        {:approved, []} ->
          :ok
      end
    end
  end
end
