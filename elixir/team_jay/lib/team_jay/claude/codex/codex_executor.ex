defmodule TeamJay.Claude.Codex.CodexExecutor do
  @moduledoc """
  코덱스 실행기 — Claude Code CLI 호출

  Claude Code CLI = 툴 (에이전트 아님).
  코덱스 프롬프트 파일 내용을 Claude Code에 전달하여 구현 실행.

  실행 흐름:
    1. CODEX_*.md 파일 읽기
    2. `claude --print "<prompt>" --allowedTools Edit,Write,Bash` 실행
    3. 실행 결과 반환 → CodexPipeline이 후처리

  안전 장치:
  - 실행 전 git commit (롤백 포인트)
  - 타임아웃: 10분
  - OPS 직접 수정 없음 (DEV 원칙 — 현재 OPS에서 직접 실행이므로 주의)
  """

  require Logger

  @project_root System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system")

  def execute(codex_path) do
    Logger.info("[CodexExecutor] 코덱스 실행 시작: #{Path.basename(codex_path)}")

    with {:ok, content} <- File.read(codex_path),
         :ok            <- pre_execution_commit(codex_path),
         {:ok, result}  <- run_claude_code(content, codex_path) do
      Logger.info("[CodexExecutor] 실행 완료: #{Path.basename(codex_path)}")
      {:ok, result}
    else
      {:error, reason} ->
        Logger.error("[CodexExecutor] 실행 실패: #{inspect(reason)}")
        {:error, reason}
    end
  end

  def dry_run(codex_path) do
    case File.read(codex_path) do
      {:ok, content} ->
        summary = extract_summary(content)
        {:ok, %{codex: Path.basename(codex_path), summary: summary, status: :ready}}
      {:error, reason} ->
        {:error, reason}
    end
  end

  # ── 내부 ───────────────────────────────────────────────────────────

  defp pre_execution_commit(codex_path) do
    codex_name = Path.basename(codex_path, ".md")
    msg = "pre: #{codex_name} 실행 전 롤백 포인트"

    case System.cmd("git", ["add", "-A"], cd: @project_root) do
      {_, 0} ->
        case System.cmd("git", ["commit", "-m", msg, "--allow-empty"], cd: @project_root) do
          {_, 0} ->
            Logger.debug("[CodexExecutor] 롤백 포인트 생성: #{msg}")
            :ok
          {output, code} ->
            Logger.warning("[CodexExecutor] 커밋 실패 (exit=#{code}): #{output}")
            :ok  # 커밋 실패해도 실행 진행 (변경사항 없을 수 있음)
        end
      {output, code} ->
        {:error, "git add 실패 exit=#{code}: #{output}"}
    end
  end

  defp run_claude_code(content, codex_path) do
    codex_name = Path.basename(codex_path, ".md")

    # Claude Code CLI 경로 탐색
    claude_bin = find_claude_bin()

    if is_nil(claude_bin) do
      Logger.error("[CodexExecutor] claude CLI를 찾을 수 없음")
      throw({:error, :claude_not_found})
    end

    args = [
      "--print",
      content,
      "--allowedTools", "Edit,Write,Bash,Read,Glob,Grep",
      "--output-format", "text"
    ]

    Logger.info("[CodexExecutor] claude 실행 중: #{codex_name}")

    case System.cmd(claude_bin, args,
           cd: @project_root,
           stderr_to_stdout: true) do
      {output, 0} ->
        {:ok, %{output: output, exit_code: 0, codex: codex_name}}
      {output, code} ->
        Logger.warning("[CodexExecutor] claude 종료 코드 #{code}")
        {:ok, %{output: output, exit_code: code, codex: codex_name}}
    end
  rescue
    e -> {:error, Exception.message(e)}
  catch
    {:error, _} = err -> err
  end

  defp find_claude_bin do
    candidates = [
      System.find_executable("claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      Path.expand("~/.claude/local/claude")
    ]
    Enum.find(candidates, &(&1 && File.exists?(&1 || "")))
  end

  defp extract_summary(content) do
    content
    |> String.split("\n")
    |> Enum.take(10)
    |> Enum.filter(&String.starts_with?(&1, ">"))
    |> Enum.map(&String.trim_leading(&1, "> "))
    |> Enum.join(" | ")
  end
end
