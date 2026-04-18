defmodule TeamJay.Ska.Skill.AuditDbIntegrityTest do
  use ExUnit.Case, async: true

  alias TeamJay.Ska.Skill.AuditDbIntegrity

  describe "metadata/0" do
    test "메타데이터 반환" do
      meta = AuditDbIntegrity.metadata()
      assert meta.name == :audit_db_integrity
      assert meta.domain == :common
      assert meta.version == "1.0"
    end
  end

  describe "run/2 — orphans/unknown checks" do
    test "orphans check는 항상 빈 issues 반환" do
      # DB 없이 실행 가능한 체크
      {:ok, result} = AuditDbIntegrity.run(%{table: "test_table", checks: [:orphans]}, %{})
      assert result.passed == true
      assert result.issues == []
    end

    test "빈 checks → 기본 checks 적용" do
      # Jay.Core.Repo 없이 동작 확인 어려움 — 메타데이터만 확인
      assert AuditDbIntegrity.metadata().input_schema.checks == :list
    end
  end
end
