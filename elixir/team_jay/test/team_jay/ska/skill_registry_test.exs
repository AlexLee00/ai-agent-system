defmodule TeamJay.Ska.SkillRegistryTest do
  use ExUnit.Case, async: false

  alias TeamJay.Ska.SkillRegistry

  defmodule TestSkill do
    @behaviour TeamJay.Ska.Skill

    def metadata do
      %{name: :test_skill, domain: :test, version: "1.0",
        description: "테스트 스킬", input_schema: %{}, output_schema: %{}}
    end

    def run(%{fail: true}, _ctx), do: {:error, :intentional_failure}
    def run(params, _ctx), do: {:ok, %{echo: params}}

    def health_check, do: :ok
  end

  setup do
    # 각 테스트에서 독립적인 SkillRegistry 프로세스를 시작
    # ETS 테이블 이름 충돌 방지를 위해 기존 프로세스 종료
    case Process.whereis(SkillRegistry) do
      nil -> :ok
      pid -> GenServer.stop(pid)
    end

    {:ok, pid} = SkillRegistry.start_link([])
    on_exit(fn -> GenServer.stop(pid) end)
    {:ok, %{registry: pid}}
  end

  describe "register/3 + fetch/1" do
    test "스킬 등록 후 조회 성공" do
      assert {:ok, _skill} = SkillRegistry.register(:test_skill, TestSkill, %{domain: :test})
      assert {:ok, skill} = SkillRegistry.fetch(:test_skill)
      assert skill.name == :test_skill
      assert skill.module == TestSkill
    end

    test "미등록 스킬 조회 → :skill_not_found" do
      assert {:error, :skill_not_found} = SkillRegistry.fetch(:nonexistent_skill)
    end
  end

  describe "execute/3" do
    setup do
      SkillRegistry.register(:test_skill, TestSkill, %{domain: :test})
      :ok
    end

    test "스킬 실행 성공" do
      assert {:ok, %{echo: %{value: 42}}} =
               SkillRegistry.execute(:test_skill, %{value: 42})
    end

    test "스킬 실행 실패" do
      assert {:error, :intentional_failure} =
               SkillRegistry.execute(:test_skill, %{fail: true})
    end

    test "미등록 스킬 실행 → :skill_not_found" do
      assert {:error, :skill_not_found} =
               SkillRegistry.execute(:nonexistent, %{})
    end
  end

  describe "list/1" do
    test "도메인 필터링" do
      SkillRegistry.register(:test_skill, TestSkill, %{domain: :test})
      skills = SkillRegistry.list(%{domain: :test})
      assert Enum.any?(skills, &(&1.name == :test_skill))
    end

    test "전체 목록 (내장 스킬 포함)" do
      all = SkillRegistry.list()
      names = Enum.map(all, & &1.name)
      assert :detect_session_expiry in names
      assert :notify_failure in names
      assert :persist_cycle_metrics in names
      assert :trigger_recovery in names
      assert :audit_db_integrity in names
    end
  end

  describe "health_check_all/0" do
    test "등록된 스킬 헬스체크" do
      SkillRegistry.register(:test_skill, TestSkill, %{domain: :test})
      results = SkillRegistry.health_check_all()
      test_result = Enum.find(results, fn {name, _} -> name == :test_skill end)
      assert test_result != nil
      assert elem(test_result, 1) == :ok
    end
  end
end
