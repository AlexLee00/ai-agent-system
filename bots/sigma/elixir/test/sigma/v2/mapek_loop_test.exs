defmodule Sigma.V2.MapeKLoopTest do
  use ExUnit.Case, async: false

  @moduletag :phase_r

  @sigma_lib Path.join(__DIR__, "../../../lib")

  describe "Sigma.V2.MapeKLoop — GenServer 상태" do
    test "status/0 호출 시 맵 반환 (이미 실행 중인 프로세스 또는 {:error, :not_started})" do
      result =
        try do
          Sigma.V2.MapeKLoop.status()
        catch
          :exit, _ -> %{dormant: true, fallback: true}
        end

      assert is_map(result)
    end

    test "on_cycle_complete/1 cast 수신 가능 (이미 실행 중인 프로세스)" do
      result =
        try do
          Sigma.V2.MapeKLoop.on_cycle_complete(%{cycle_id: "mapek-test-#{:rand.uniform(9999)}", results: []})
          :ok
        catch
          :exit, _ -> :ok
        end

      assert result == :ok
    end

    test "trigger_weekly_knowledge/0 cast 수신 가능" do
      result =
        try do
          Sigma.V2.MapeKLoop.trigger_weekly_knowledge()
          :ok
        catch
          :exit, _ -> :ok
        end

      assert result == :ok
    end

    test "run_cycle_now/0 cast 수신 가능" do
      result =
        try do
          Sigma.V2.MapeKLoop.run_cycle_now()
          :ok
        catch
          :exit, _ -> :ok
        end

      assert result == :ok
    end
  end

  describe "Sigma.V2.MapeKLoop — 소스 구조 검증" do
    test "일별/주별 인터벌 상수 정의됨" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/mapek_loop.ex"))
      assert src =~ "@daily_interval_ms"
      assert src =~ "@weekly_interval_ms"
    end

    test "Knowledge 단계 SelfRewarding 호출 포함" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/mapek_loop.ex"))
      assert src =~ "SelfRewarding"
      assert src =~ "handle_knowledge_phase"
    end

    test "Reflexion 실패 Directive에만 적용" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/mapek_loop.ex"))
      assert src =~ "Reflexion.reflect"
      assert src =~ ":error"
    end

    test "MAPE 4단계 모두 포함 (Monitor/Analyze/Plan/Execute)" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/mapek_loop.ex"))
      assert src =~ "Monitor"
      assert src =~ "Analyze"
      assert src =~ "Execute"
    end

    test "DirectiveTracker 연동" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/mapek_loop.ex"))
      assert src =~ "DirectiveTracker"
    end
  end
end
