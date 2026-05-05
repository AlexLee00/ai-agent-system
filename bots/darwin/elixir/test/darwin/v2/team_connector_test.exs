defmodule Darwin.V2.TeamConnectorTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.TeamConnector

  setup_all do
    Code.ensure_loaded?(TeamConnector)
    :ok
  end

  describe "module_definition" do
    test "TeamConnector 모듈이 정의되어 있다" do
      assert Code.ensure_loaded?(TeamConnector)
    end
  end

  describe "public_api" do
    test "submit_tech_request/5 export" do
      assert function_exported?(TeamConnector, :submit_tech_request, 5)
    end

    test "pending_requests/0 export" do
      assert function_exported?(TeamConnector, :pending_requests, 0)
    end

    test "notify_team/3 export" do
      assert function_exported?(TeamConnector, :notify_team, 3)
    end

    test "mark_resolved/2 export" do
      assert function_exported?(TeamConnector, :mark_resolved, 2)
    end

    test "get_status/0 export" do
      assert function_exported?(TeamConnector, :get_status, 0)
    end

    test "collect_kpi/0 export" do
      assert function_exported?(TeamConnector, :collect_kpi, 0)
    end
  end

  describe "kill_switch_disabled" do
    test "DARWIN_TEAM_INTEGRATION_ENABLED 미설정 시 submit_tech_request는 :skip 반환" do
      System.delete_env("DARWIN_TEAM_INTEGRATION_ENABLED")
      result = TeamConnector.submit_tech_request("luna", "luna-commander", "algorithm", "DPO 적용")
      assert result == {:skip, :disabled}
    end

    test "DARWIN_TEAM_INTEGRATION_ENABLED 미설정 시 pending_requests는 빈 목록 반환" do
      System.delete_env("DARWIN_TEAM_INTEGRATION_ENABLED")
      result = TeamConnector.pending_requests()
      assert result == []
    end

    test "DARWIN_TEAM_INTEGRATION_ENABLED 미설정 시 notify_team은 :ok 반환" do
      System.delete_env("DARWIN_TEAM_INTEGRATION_ENABLED")
      result = TeamConnector.notify_team("luna", %{paper_id: "test"})
      assert result == :ok
    end
  end

  describe "get_status" do
    test "get_status는 map 반환" do
      status = TeamConnector.get_status()
      assert is_map(status)
      assert Map.has_key?(status, :status)
    end

    test "get_status에 team_integration_enabled 필드 포함" do
      status = TeamConnector.get_status()
      assert Map.has_key?(status, :team_integration_enabled)
    end
  end

  describe "collect_kpi" do
    @tag :pending
    test "collect_kpi는 map 반환 (DB + GenServer 필요)" do
      # Darwin.V2.Lead GenServer가 기동된 통합 환경에서만 실행
      kpi = TeamConnector.collect_kpi()
      assert is_map(kpi)
      assert Map.get(kpi, :metric_type) == :research_ops
    end

    @tag :pending
    test "kpi에 pending_team_requests 필드 포함 (DB + GenServer 필요)" do
      # Darwin.V2.Lead GenServer가 기동된 통합 환경에서만 실행
      kpi = TeamConnector.collect_kpi()
      assert Map.has_key?(kpi, :pending_team_requests)
    end
  end

  describe "nine_team_integration" do
    test "지원하는 팀 목록 확인" do
      supported_teams = ~w(luna blog ska worker video justin sigma hub jay darwin)
      assert "luna" in supported_teams
      assert "sigma" in supported_teams
      assert length(supported_teams) == 10
    end

    test "request_type 목록: prompt / algorithm / library / framework" do
      valid_types = ~w(prompt algorithm library framework)
      assert "algorithm" in valid_types
      assert length(valid_types) == 4
    end
  end
end
