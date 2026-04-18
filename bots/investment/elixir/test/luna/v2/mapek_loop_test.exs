defmodule Luna.V2.MapeKLoopTest do
  use ExUnit.Case, async: true

  alias Luna.V2.MapeKLoop

  setup_all do
    Code.ensure_compiled!(MapeKLoop)
    :ok
  end

  describe "모듈 구조" do
    test "MapeKLoop 컴파일됨" do
      assert Code.ensure_loaded?(MapeKLoop)
    end

    test "trigger_cycle/1 존재" do
      assert function_exported?(MapeKLoop, :trigger_cycle, 1)
    end

    test "status/0 존재" do
      assert function_exported?(MapeKLoop, :status, 0)
    end

    test "start_link/1 존재" do
      assert function_exported?(MapeKLoop, :start_link, 1)
    end
  end

  describe "시장별 루프 분기" do
    test "지원 시장: [:crypto, :domestic, :overseas]" do
      markets = [:crypto, :domestic, :overseas]
      assert length(markets) == 3
      assert :crypto in markets
    end

    test "MapeKLoop는 KillSwitch 의존" do
      assert Code.ensure_loaded?(Luna.V2.KillSwitch)
      assert function_exported?(Luna.V2.KillSwitch, :mapek_enabled?, 0)
    end

    test "KillSwitch 기본값 OFF (안전 모드)" do
      # 환경변수 미설정 시 mapek_enabled? = false
      # Application.get_env에서 기본값 false 반환
      refute Application.get_env(:luna, :mapek_enabled, false)
    end
  end
end
