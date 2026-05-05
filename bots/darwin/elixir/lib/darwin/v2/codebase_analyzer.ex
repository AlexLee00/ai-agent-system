defmodule Darwin.V2.CodebaseAnalyzer do
  @moduledoc """
  다윈팀 V2 코드베이스 자동 분석 — Phase H.

  매주 9팀 코드를 분석해:
  1. 파일별 LOC / 함수 수 / 복잡도 측정
  2. 500줄 초과 파일 (분리 후보) 탐지
  3. 외부 논문 ↔ 코드 패턴 매칭 → Hypothesis 후보 생성
  4. 주간 자기 보고서 생성 + DB 저장

  Kill Switch: DARWIN_CODEBASE_ANALYZER_ENABLED=true
  """

  use GenServer
  require Logger
  alias Jay.Core.Repo

  # 컴파일 타임 프로젝트 루트 (필요 시 PROJECT_ROOT 환경변수로 오버라이드)
  @compile_time_root Path.expand("../../../../../../..", __DIR__)

  @team_dirs %{
    "luna"   => "bots/investment",
    "blog"   => "bots/blog",
    "ska"    => "bots/reservation",
    "sigma"  => "bots/sigma",
    "hub"    => "bots/hub",
    "darwin" => "bots/darwin",
    "jay"    => "elixir",
    "worker" => "bots/worker",
    "video"  => "bots/video"
  }

  @code_extensions ~w(.ts .tsx .ex .exs .js .jsx .py)
  @exclude_dirs ~w(node_modules _build deps dist .elixir_ls __pycache__ .git experimental sandbox)

  @loc_threshold 500

  # ─────────────────────────────────────────────────
  # OTP
  # ─────────────────────────────────────────────────

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl GenServer
  def init(_opts) do
    Logger.info("[darwin/codebase_analyzer] 코드베이스 분석기 기동")
    {:ok, %{reports_generated: 0, last_run_at: nil}}
  end

  def status, do: GenServer.call(__MODULE__, :status)
  def run, do: GenServer.cast(__MODULE__, :run)

  @impl GenServer
  def handle_call(:status, _from, state) do
    {:reply, Map.merge(state, %{enabled: enabled?(), threshold: @loc_threshold}), state}
  end

  @impl GenServer
  def handle_cast(:run, state) do
    if enabled?() do
      case do_run() do
        {:ok, report_id} ->
          Logger.info("[darwin/codebase_analyzer] 주간 분석 완료 report_id=#{report_id}")
          new_state = %{state | reports_generated: state.reports_generated + 1, last_run_at: DateTime.utc_now()}
          {:noreply, new_state}

        {:error, reason} ->
          Logger.error("[darwin/codebase_analyzer] 분석 실패: #{inspect(reason)}")
          {:noreply, state}
      end
    else
      {:noreply, state}
    end
  end

  # ─────────────────────────────────────────────────
  # Public API
  # ─────────────────────────────────────────────────

  @doc """
  전체 코드베이스 분석 + 주간 보고서 저장.

  Kill Switch: DARWIN_CODEBASE_ANALYZER_ENABLED
  """
  @spec analyze_all() :: {:ok, integer()} | {:skip, :disabled} | {:error, term()}
  def analyze_all do
    if enabled?(), do: do_run(), else: {:skip, :disabled}
  end

  @doc "특정 팀 코드 분석 (Kill Switch 무관)."
  @spec analyze_team(String.t()) :: {:ok, map()} | {:error, term()}
  def analyze_team(team) do
    case Map.get(@team_dirs, team) do
      nil -> {:error, {:unknown_team, team}}
      rel -> {:ok, scan_dir(Path.join(project_root(), rel))}
    end
  end

  @doc "500줄 초과 파일 목록 (DB 기준)."
  @spec refactoring_candidates(pos_integer()) :: [map()]
  def refactoring_candidates(threshold \\ @loc_threshold) do
    sql = """
    SELECT team, file_path, loc, function_count, complexity, inserted_at
    FROM darwin_module_metrics
    WHERE loc >= $1
    ORDER BY loc DESC
    LIMIT 50
    """

    query_rows(sql, [threshold])
  end

  @doc "최근 주간 보고서 1건."
  @spec latest_report() :: map() | nil
  def latest_report do
    sql = """
    SELECT id, summary_text, total_loc, total_files, teams_analyzed,
           refactoring_count, inserted_at
    FROM darwin_codebase_reports
    ORDER BY inserted_at DESC
    LIMIT 1
    """

    case Repo.query(sql, []) do
      {:ok, %{rows: [row], columns: cols}} ->
        cols |> Enum.map(&String.to_atom/1) |> Enum.zip(row) |> Map.new()
      _ ->
        nil
    end
  rescue
    _ -> nil
  end

  @doc """
  분리 후보 파일과 관련된 논문 매칭 — Hypothesis 후보 생성용.
  reservation.rag_research 에서 파일 경로 키워드 기반 검색.
  """
  @spec match_papers_to_candidates() :: [map()]
  def match_papers_to_candidates do
    candidates = refactoring_candidates()

    if candidates == [] do
      []
    else
      candidates
      |> Enum.take(5)
      |> extract_keywords()
      |> query_related_papers()
    end
  end

  # ─────────────────────────────────────────────────
  # Private — 분석 로직
  # ─────────────────────────────────────────────────

  defp do_run do
    root = project_root()
    Logger.info("[darwin/codebase_analyzer] 9팀 분석 시작 project_root=#{root}")

    team_results =
      @team_dirs
      |> Enum.map(fn {team, rel} ->
        result = scan_dir(Path.join(root, rel))
        Logger.debug("[darwin/codebase_analyzer] #{team}: #{result.total_files}파일 #{result.total_loc}줄")
        {team, result}
      end)
      |> Map.new()

    total_loc = team_results |> Map.values() |> Enum.map(& &1.total_loc) |> Enum.sum()
    total_files = team_results |> Map.values() |> Enum.map(& &1.total_files) |> Enum.sum()

    refactor_list =
      team_results
      |> Enum.flat_map(fn {team, result} ->
        result.files
        |> Enum.filter(&(&1.loc >= @loc_threshold))
        |> Enum.map(&Map.put(&1, :team, team))
      end)
      |> Enum.sort_by(& &1.loc, :desc)

    summary = build_summary(team_results, refactor_list, total_loc, total_files)

    save_report(team_results, refactor_list, summary, total_loc, total_files)
  end

  defp scan_dir(dir) do
    if File.dir?(dir) do
      files =
        @code_extensions
        |> Enum.flat_map(&Path.wildcard(Path.join([dir, "**", "*#{&1}"])))
        |> Enum.reject(&excluded_path?/1)
        |> Enum.map(&analyze_file/1)
        |> Enum.reject(&is_nil/1)

      %{
        total_loc: files |> Enum.map(& &1.loc) |> Enum.sum(),
        total_files: length(files),
        files: files
      }
    else
      %{total_loc: 0, total_files: 0, files: []}
    end
  end

  defp excluded_path?(path) do
    Enum.any?(@exclude_dirs, &String.contains?(path, "/#{&1}/"))
  end

  defp analyze_file(path) do
    case File.read(path) do
      {:ok, content} ->
        %{
          file_path: path,
          loc: content |> String.split("\n") |> length(),
          function_count: count_functions(content, path),
          complexity: estimate_complexity(content)
        }

      {:error, _} ->
        nil
    end
  rescue
    _ -> nil
  end

  defp count_functions(content, path) do
    cond do
      String.ends_with?(path, ".ex") or String.ends_with?(path, ".exs") ->
        Regex.scan(~r/^\s+defp?\s+\w+/m, content) |> length()

      String.ends_with?(path, ".ts") or String.ends_with?(path, ".tsx") or
          String.ends_with?(path, ".js") or String.ends_with?(path, ".jsx") ->
        patterns = [
          ~r/(?:async\s+)?function\s+\w+/m,
          ~r/^\s+(?:async\s+)?(?:public|private|protected)?\s+\w+\s*\([^)]*\)\s*\{/m
        ]

        patterns |> Enum.map(&(Regex.scan(&1, content) |> length())) |> Enum.sum()

      true ->
        0
    end
  end

  defp estimate_complexity(content) do
    ~w(case if else cond with rescue catch)
    |> Enum.map(&(Regex.scan(~r/\b#{&1}\b/, content) |> length()))
    |> Enum.sum()
  end

  # ─────────────────────────────────────────────────
  # Private — 보고서 텍스트
  # ─────────────────────────────────────────────────

  defp build_summary(team_results, refactor_list, total_loc, total_files) do
    header = [
      "# 다윈팀 코드베이스 주간 분석",
      "생성: #{DateTime.utc_now() |> DateTime.to_iso8601()}",
      "",
      "## 전체 현황",
      "- 총 LOC: #{fmt_num(total_loc)}",
      "- 총 파일: #{total_files}",
      "- 분리 후보: #{length(refactor_list)}개 (#{@loc_threshold}줄+)",
      "",
      "## 팀별 현황",
      "",
      "| 팀 | LOC | 파일 |",
      "|---|---|---|"
    ]

    team_rows =
      team_results
      |> Enum.sort_by(fn {_, r} -> -r.total_loc end)
      |> Enum.map(fn {team, r} ->
        "| #{team} | #{fmt_num(r.total_loc)} | #{r.total_files} |"
      end)

    refactor_section =
      if refactor_list == [] do
        ["", "## 분리 후보 없음 — 모든 파일 #{@loc_threshold}줄 이하 ✅"]
      else
        items =
          refactor_list
          |> Enum.take(10)
          |> Enum.map(fn f ->
            rel = String.replace(f.file_path, project_root() <> "/", "")
            "- `#{rel}` (#{f.loc}줄, #{f.team})"
          end)

        ["", "## 분리 후보 Top 10 (#{@loc_threshold}줄+)", ""] ++ items
      end

    (header ++ team_rows ++ refactor_section) |> Enum.join("\n")
  end

  # ─────────────────────────────────────────────────
  # Private — DB 저장
  # ─────────────────────────────────────────────────

  defp save_report(team_results, refactor_list, summary, total_loc, total_files) do
    sql = """
    INSERT INTO darwin_codebase_reports
      (summary_text, total_loc, total_files, teams_analyzed, refactoring_count, inserted_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    RETURNING id
    """

    case Repo.query(sql, [
           summary,
           total_loc,
           total_files,
           Map.keys(team_results),
           length(refactor_list)
         ]) do
      {:ok, %{rows: [[report_id]]}} ->
        save_module_metrics(team_results, report_id)
        {:ok, report_id}

      {:error, reason} ->
        Logger.error("[darwin/codebase_analyzer] 보고서 저장 실패: #{inspect(reason)}")
        {:error, reason}
    end
  rescue
    e -> {:error, e}
  end

  defp save_module_metrics(team_results, report_id) do
    Enum.each(team_results, fn {team, result} ->
      result.files
      |> Enum.filter(&(&1.loc >= 100))
      |> Enum.each(fn file ->
        sql = """
        INSERT INTO darwin_module_metrics
          (report_id, team, file_path, loc, function_count, complexity, inserted_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT DO NOTHING
        """

        case Repo.query(sql, [report_id, team, file.file_path, file.loc, file.function_count, file.complexity]) do
          {:ok, _} -> :ok
          {:error, e} -> Logger.warning("[darwin/codebase_analyzer] 메트릭 저장 실패: #{inspect(e)}")
        end
      end)
    end)
  end

  # ─────────────────────────────────────────────────
  # Private — 논문 매칭
  # ─────────────────────────────────────────────────

  defp extract_keywords(candidates) do
    candidates
    |> Enum.flat_map(fn f ->
      f.file_path
      |> Path.basename()
      |> Path.rootname()
      |> String.split(~r/[-_]/)
      |> Enum.reject(&(String.length(&1) < 4))
    end)
    |> Enum.uniq()
    |> Enum.take(8)
  end

  defp query_related_papers([]), do: []

  defp query_related_papers(keywords) do
    patterns = Enum.map(keywords, &"%#{&1}%")

    sql = """
    SELECT id, title, score
    FROM reservation.rag_research
    WHERE title ILIKE ANY($1::text[])
    ORDER BY score DESC
    LIMIT 5
    """

    query_rows(sql, [patterns])
  rescue
    _ -> []
  end

  # ─────────────────────────────────────────────────
  # Private — 헬퍼
  # ─────────────────────────────────────────────────

  defp query_rows(sql, params) do
    case Repo.query(sql, params) do
      {:ok, %{rows: rows, columns: cols}} ->
        Enum.map(rows, fn row ->
          cols |> Enum.map(&String.to_atom/1) |> Enum.zip(row) |> Map.new()
        end)

      _ ->
        []
    end
  rescue
    _ -> []
  end

  defp fmt_num(n) when n >= 1_000 do
    "#{div(n, 1_000)},#{String.pad_leading(to_string(rem(n, 1_000)), 3, "0")}"
  end

  defp fmt_num(n), do: to_string(n)

  defp project_root do
    System.get_env("PROJECT_ROOT") || @compile_time_root
  end

  defp enabled? do
    System.get_env("DARWIN_CODEBASE_ANALYZER_ENABLED") == "true"
  end
end
