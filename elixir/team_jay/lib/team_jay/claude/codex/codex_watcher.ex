defmodule TeamJay.Claude.Codex.CodexWatcher do
  @moduledoc """
  CODEX 파일 감시자 — docs/codex/ 디렉토리 폴링

  60초마다 docs/codex/CODEX_*.md 파일 변경 감지:
  - 새 파일 → CodexPipeline에 알림
  - 수정된 파일 → CodexPipeline에 알림
  - 완료/아카이브된 파일 → 무시

  Phase 1: 감지 → 마스터 텔레그램 발송 (승인 후 실행)
  Phase 3: 감지 → 자동 실행
  """

  use GenServer
  require Logger

  @codex_dir "docs/codex"
  @poll_interval 60_000  # 60초
  @project_root System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system")

  defstruct [
    known_files: %{},   # %{path => mtime}
    scan_count: 0,
    last_scan: nil
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  def scan_now do
    GenServer.cast(__MODULE__, :scan)
  end

  @impl true
  def init(_opts) do
    Process.send_after(self(), :scan, 5_000)  # 5초 후 첫 스캔
    Logger.info("[CodexWatcher] CODEX 파일 감시 시작! dir=#{@codex_dir}")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:scan, state) do
    Process.send_after(self(), :scan, @poll_interval)
    {:noreply, do_scan(state)}
  end

  @impl true
  def handle_cast(:scan, state) do
    {:noreply, do_scan(state)}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      known_files: map_size(state.known_files),
      scan_count: state.scan_count,
      last_scan: state.last_scan
    }, state}
  end

  # ── 스캔 로직 ─────────────────────────────────────────────────────

  defp do_scan(state) do
    dir = Path.join(@project_root, @codex_dir)
    now = DateTime.utc_now()

    current_files = scan_codex_files(dir)

    # 신규 + 수정된 파일 감지
    {new_files, changed_files} = detect_changes(current_files, state.known_files)

    Enum.each(new_files, fn {path, _mtime} ->
      Logger.info("[CodexWatcher] 신규 CODEX 감지: #{Path.basename(path)}")
      notify_pipeline(path, :new)
    end)

    Enum.each(changed_files, fn {path, _mtime} ->
      Logger.info("[CodexWatcher] CODEX 수정 감지: #{Path.basename(path)}")
      notify_pipeline(path, :changed)
    end)

    %{state |
      known_files: current_files,
      scan_count: state.scan_count + 1,
      last_scan: now
    }
  end

  defp scan_codex_files(dir) do
    case File.ls(dir) do
      {:ok, files} ->
        files
        |> Enum.filter(&String.match?(&1, ~r/^CODEX_.*\.md$/))
        |> Enum.reject(&String.contains?(&1, "SECURITY_AUDIT"))  # 보안 파일 제외
        |> Enum.reduce(%{}, fn filename, acc ->
          path = Path.join(dir, filename)
          case File.stat(path) do
            {:ok, %{mtime: mtime}} -> Map.put(acc, path, mtime)
            _ -> acc
          end
        end)
      _ ->
        %{}
    end
  end

  defp detect_changes(current, known) do
    new_files = Enum.filter(current, fn {path, _} -> not Map.has_key?(known, path) end)
    changed_files = Enum.filter(current, fn {path, mtime} ->
      case Map.get(known, path) do
        nil -> false
        old_mtime -> mtime != old_mtime
      end
    end)
    {new_files, changed_files}
  end

  defp notify_pipeline(path, type) do
    codex_name = Path.basename(path, ".md")
    TeamJay.Claude.Codex.CodexPipeline.codex_detected(codex_name, path, type)
  end
end
