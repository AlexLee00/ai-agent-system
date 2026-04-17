defmodule TeamJay.Claude.Doctor.SnapshotManager do
  @moduledoc """
  닥터팀 스냅샷 관리 — git stash + 롤백

  패치 적용 전 스냅샷 생성 + 실패 시 자동 롤백.
  Phase 2 (Level 1↑)에서 활성화.

  현재: 스냅샷 API만 노출 (Level 2에서 자동 호출)
  """

  require Logger

  @project_root System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system")

  def create_snapshot(label) do
    stash_msg = "doctor-snapshot:#{label}:#{DateTime.utc_now() |> DateTime.to_unix()}"
    case System.cmd("git", ["stash", "push", "-m", stash_msg], cd: @project_root) do
      {output, 0} ->
        Logger.info("[SnapshotManager] 스냅샷 생성: #{stash_msg}")
        {:ok, stash_msg, output}
      {output, code} ->
        Logger.error("[SnapshotManager] 스냅샷 실패: exit=#{code} #{output}")
        {:error, output}
    end
  end

  def rollback(stash_ref) do
    case System.cmd("git", ["stash", "pop"], cd: @project_root) do
      {output, 0} ->
        Logger.info("[SnapshotManager] 롤백 완료: #{stash_ref}")
        {:ok, output}
      {output, code} ->
        Logger.error("[SnapshotManager] 롤백 실패: exit=#{code} #{output}")
        {:error, output}
    end
  end

  def list_snapshots do
    case System.cmd("git", ["stash", "list"], cd: @project_root) do
      {output, 0} ->
        snaps = output
        |> String.split("\n", trim: true)
        |> Enum.filter(&String.contains?(&1, "doctor-snapshot"))
        {:ok, snaps}
      {_, _} ->
        {:ok, []}
    end
  end
end
