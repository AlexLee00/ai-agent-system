defmodule Jay.Core.LLM.TelemetryTest do
  use ExUnit.Case, async: true

  alias Jay.Core.LLM.Telemetry

  describe "span/3" do
    test "성공 함수 결과 통과" do
      result = Telemetry.span([:jay, :llm, :test], %{agent: "test"}, fn -> {:ok, "hello"} end)
      assert result == {:ok, "hello"}
    end

    test "예외 발생 시 reraise" do
      assert_raise RuntimeError, "테스트 에러", fn ->
        Telemetry.span([:jay, :llm, :test], %{}, fn -> raise "테스트 에러" end)
      end
    end

    test "telemetry :start 이벤트 발행" do
      events = capture_telemetry([:jay, :llm, :span_start_test, :start], fn ->
        Telemetry.span([:jay, :llm, :span_start_test], %{team: "test"}, fn -> :ok end)
      end)
      assert length(events) == 1
      [{_event, _measurements, meta}] = events
      assert meta.team == "test"
    end

    test "telemetry :stop 이벤트 발행" do
      events = capture_telemetry([:jay, :llm, :span_stop_test, :stop], fn ->
        Telemetry.span([:jay, :llm, :span_stop_test], %{}, fn -> :done end)
      end)
      assert length(events) == 1
    end
  end

  describe "emit_call_start/3" do
    test "이벤트 발행 성공" do
      events = capture_telemetry([:jay, :llm, :call, :start], fn ->
        Telemetry.emit_call_start("test_agent", "anthropic_haiku", "test_team")
      end)
      assert length(events) == 1
      [{_event, _measurements, meta}] = events
      assert meta.agent == "test_agent"
      assert meta.model == "anthropic_haiku"
      assert meta.team == "test_team"
    end
  end

  describe "emit_call_stop/5" do
    test "성공 이벤트 발행" do
      events = capture_telemetry([:jay, :llm, :call, :stop], fn ->
        Telemetry.emit_call_stop("test_agent", "anthropic_haiku", "test_team", 150, true)
      end)
      assert length(events) == 1
      [{_event, measurements, meta}] = events
      assert measurements.duration_ms == 150
      assert meta.ok == true
    end

    test "실패 이벤트 발행" do
      events = capture_telemetry([:jay, :llm, :call, :stop], fn ->
        Telemetry.emit_call_stop("test_agent", "anthropic_haiku", "test_team", 5000, false)
      end)
      assert length(events) == 1
      [{_event, measurements, meta}] = events
      assert meta.ok == false
      assert measurements.duration_ms == 5000
    end
  end

  describe "emit_cache_hit/2" do
    test "캐시 히트 이벤트 발행" do
      events = capture_telemetry([:jay, :llm, :cache, :hit], fn ->
        Telemetry.emit_cache_hit("cached_agent", "anthropic_haiku")
      end)
      assert length(events) == 1
      [{_event, _measurements, meta}] = events
      assert meta.agent == "cached_agent"
      assert meta.model == "anthropic_haiku"
    end
  end

  describe "emit_budget_warn/2" do
    test "예산 경고 이벤트 발행" do
      events = capture_telemetry([:jay, :llm, :budget, :warn], fn ->
        Telemetry.emit_budget_warn("luna", 0.85)
      end)
      assert length(events) == 1
      [{_event, measurements, meta}] = events
      assert measurements.ratio == 0.85
      assert meta.team == "luna"
    end
  end

  # 헬퍼: telemetry 이벤트 캡처
  defp capture_telemetry(event, fun) do
    test_pid = self()
    handler_id = make_ref()

    :telemetry.attach(
      handler_id,
      event,
      fn ev, measurements, meta, _cfg ->
        send(test_pid, {:telemetry_event, ev, measurements, meta})
      end,
      nil
    )

    fun.()

    events = collect_events([])
    :telemetry.detach(handler_id)
    events
  end

  defp collect_events(acc) do
    receive do
      {:telemetry_event, event, measurements, meta} ->
        collect_events([{event, measurements, meta} | acc])
    after
      50 -> Enum.reverse(acc)
    end
  end
end
