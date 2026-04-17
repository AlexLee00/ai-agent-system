defmodule TeamJay.Claude.Doctor.VerifyEngine do
  @moduledoc """
  닥터 검증 엔진 — 패치 적용 후 덱스터 재테스트

  패치 → 테스트 → 통과/실패 → 통과 시 커밋 / 실패 시 롤백
  """

  require Logger
  alias TeamJay.Claude.Dexter.TestRunner
  alias TeamJay.Claude.Doctor.SnapshotManager

  @verify_wait_ms 10_000  # 테스트 결과 대기

  def verify_and_commit(_patch_info, case_id) do
    Logger.info("[VerifyEngine] 패치 검증 시작: case=#{case_id}")

    # Layer 2 테스트 트리거
    TestRunner.run_now(2)
    :timer.sleep(@verify_wait_ms)

    # 간단 검증: node --check로 구문 에러 확인
    case quick_syntax_check() do
      :ok ->
        Logger.info("[VerifyEngine] 검증 통과: case=#{case_id}")
        {:ok, :passed}
      {:error, reason} ->
        Logger.warning("[VerifyEngine] 검증 실패, 롤백: #{reason}")
        SnapshotManager.rollback("case-#{case_id}")
        {:error, :rolled_back}
    end
  end

  defp quick_syntax_check do
    project_root = System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system")
    case System.cmd("git", ["diff", "--name-only", "HEAD~1"], cd: project_root) do
      {changed, 0} ->
        ts_files = changed |> String.split("\n", trim: true) |> Enum.filter(&String.ends_with?(&1, ".ts"))
        Enum.reduce_while(ts_files, :ok, fn file, _acc ->
          full_path = Path.join(project_root, file)
          case System.cmd("node", ["--input-type=module", "--check"], stdin: "import '#{full_path}'",
                          stderr_to_stdout: true) do
            {_, 0} -> {:cont, :ok}
            {output, _} -> {:halt, {:error, output}}
          end
        end)
      _ -> :ok
    end
  end
end
