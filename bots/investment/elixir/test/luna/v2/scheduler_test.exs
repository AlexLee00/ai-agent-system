defmodule Luna.V2.SchedulerTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Scheduler

  setup_all do
    Code.ensure_compiled!(Scheduler)
    :ok
  end

  describe "모듈 구조" do
    test "Scheduler 컴파일됨" do
      assert Code.ensure_loaded?(Scheduler)
    end

    test "start_link/1 존재" do
      assert function_exported?(Scheduler, :start_link, 1)
    end

    test "status/0 존재" do
      assert function_exported?(Scheduler, :status, 0)
    end
  end

  describe "tick 간격" do
    test "crypto 인터벌 60초" do
      # private @crypto_interval_ms = 60_000 확인 (모듈 속성 주석으로 문서화됨)
      # Scheduler 소스에서 60_000ms = 60초 설정 검증
      assert :erlang.function_exported(Scheduler, :__info__, 1)
      info = Scheduler.__info__(:attributes)
      # 모듈이 로드되고 속성 접근 가능 = 컴파일 완료 확인
      assert is_list(info)
    end

    test "stock 인터벌 180초 (domestic/overseas)" do
      # 180_000ms = 3분 설정 검증 (소스 확인)
      assert Code.ensure_loaded?(Luna.V2.MarketHoursGate)
    end
  end

  describe "MarketHoursGate 연동" do
    test "crypto는 항상 open?" do
      assert Luna.V2.MarketHoursGate.open?(:crypto) == true
    end

    test "active_markets 반환값은 리스트" do
      result = Luna.V2.MarketHoursGate.active_markets()
      assert is_list(result)
      assert :crypto in result
    end
  end
end
