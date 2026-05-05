defmodule Darwin.V2.CodebaseAnalyzerTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.CodebaseAnalyzer

  setup_all do
    Code.ensure_loaded?(CodebaseAnalyzer)
    :ok
  end

  describe "module_definition" do
    test "CodebaseAnalyzer 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(CodebaseAnalyzer)
    end

    test "Phase H GenServer 모듈" do
      assert CodebaseAnalyzer.__info__(:module) == Darwin.V2.CodebaseAnalyzer
    end
  end

  describe "public_api" do
    test "start_link/1 export" do
      assert function_exported?(CodebaseAnalyzer, :start_link, 1)
    end

    test "status/0 export" do
      assert function_exported?(CodebaseAnalyzer, :status, 0)
    end

    test "run/0 export" do
      assert function_exported?(CodebaseAnalyzer, :run, 0)
    end

    test "analyze_all/0 export" do
      assert function_exported?(CodebaseAnalyzer, :analyze_all, 0)
    end

    test "analyze_team/1 export" do
      assert function_exported?(CodebaseAnalyzer, :analyze_team, 1)
    end

    test "refactoring_candidates/1 export" do
      assert function_exported?(CodebaseAnalyzer, :refactoring_candidates, 1)
    end

    test "latest_report/0 export" do
      assert function_exported?(CodebaseAnalyzer, :latest_report, 0)
    end

    test "match_papers_to_candidates/0 export" do
      assert function_exported?(CodebaseAnalyzer, :match_papers_to_candidates, 0)
    end
  end

  describe "kill_switch_disabled" do
    test "DARWIN_CODEBASE_ANALYZER_ENABLED 미설정 시 analyze_all은 :skip 반환" do
      System.delete_env("DARWIN_CODEBASE_ANALYZER_ENABLED")
      result = CodebaseAnalyzer.analyze_all()
      assert result == {:skip, :disabled}
    end
  end

  describe "analyze_team" do
    test "알 수 없는 팀은 unknown_team 에러 반환" do
      result = CodebaseAnalyzer.analyze_team("unknown_team_xyz")
      assert {:error, {:unknown_team, "unknown_team_xyz"}} = result
    end

    test "darwin 팀 분석 가능 (kill switch 무관)" do
      result = CodebaseAnalyzer.analyze_team("darwin")
      assert {:ok, metrics} = result
      assert is_map(metrics)
      assert Map.has_key?(metrics, :total_loc)
      assert Map.has_key?(metrics, :total_files)
      assert Map.has_key?(metrics, :files)
    end

    test "darwin 팀 total_loc는 0 이상" do
      {:ok, metrics} = CodebaseAnalyzer.analyze_team("darwin")
      assert metrics.total_loc >= 0
    end

    test "darwin 팀 total_files는 0 이상" do
      {:ok, metrics} = CodebaseAnalyzer.analyze_team("darwin")
      assert metrics.total_files >= 0
    end

    test "files 필드는 list" do
      {:ok, metrics} = CodebaseAnalyzer.analyze_team("darwin")
      assert is_list(metrics.files)
    end

    test "각 파일 항목은 file_path, loc, function_count, complexity 포함" do
      {:ok, metrics} = CodebaseAnalyzer.analyze_team("darwin")

      Enum.each(metrics.files, fn file ->
        assert Map.has_key?(file, :file_path)
        assert Map.has_key?(file, :loc)
        assert Map.has_key?(file, :function_count)
        assert Map.has_key?(file, :complexity)
      end)
    end

    test "존재하는 모든 팀을 분석 가능" do
      teams = ~w(luna blog ska sigma hub darwin jay worker video)

      Enum.each(teams, fn team ->
        result = CodebaseAnalyzer.analyze_team(team)
        assert {:ok, _} = result, "팀 #{team} 분석 실패"
      end)
    end
  end

  describe "refactoring_candidates" do
    test "DB 없어도 빈 리스트 반환 (에러 없음)" do
      result = CodebaseAnalyzer.refactoring_candidates(500)
      assert is_list(result)
    end

    test "기본 임계값 500 사용" do
      result = CodebaseAnalyzer.refactoring_candidates()
      assert is_list(result)
    end

    test "높은 임계값으로 빈 결과 반환 가능" do
      result = CodebaseAnalyzer.refactoring_candidates(999_999)
      assert is_list(result)
    end
  end

  describe "latest_report" do
    test "DB 없어도 nil 또는 map 반환 (에러 없음)" do
      result = CodebaseAnalyzer.latest_report()
      assert is_nil(result) or is_map(result)
    end
  end

  describe "match_papers_to_candidates" do
    test "DB 없어도 리스트 반환 (에러 없음)" do
      result = CodebaseAnalyzer.match_papers_to_candidates()
      assert is_list(result)
    end
  end

  describe "config_integration" do
    test "Config.codebase_analyzer_enabled? 함수 존재" do
      assert function_exported?(Darwin.V2.Config, :codebase_analyzer_enabled?, 0)
    end

    test "DARWIN_CODEBASE_ANALYZER_ENABLED 미설정 시 false 반환" do
      System.delete_env("DARWIN_CODEBASE_ANALYZER_ENABLED")
      System.delete_env("DARWIN_V2_ENABLED")
      assert Darwin.V2.Config.codebase_analyzer_enabled?() == false
    end
  end

  describe "supervisor_integration" do
    test "Supervisor 모듈 로드됨" do
      assert Code.ensure_loaded?(Darwin.V2.Supervisor)
    end
  end
end
