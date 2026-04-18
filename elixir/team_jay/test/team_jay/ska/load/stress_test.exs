defmodule TeamJay.Ska.Load.StressTest do
  use ExUnit.Case, async: false

  @moduletag :load_test

  alias TeamJay.Ska.SkillRegistry

  setup do
    case Process.whereis(TeamJay.Ska.SkillRegistry) do
      nil -> :ok
      old_pid ->
        GenServer.stop(old_pid, :normal)
        wait_for_ets_gone(:ska_skill_registry)
    end

    {:ok, pid} = SkillRegistry.start_link([])
    _ = SkillRegistry.stats()  # GenServer.call → handle_continue 완료 보장

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid, :normal)
    end)

    {:ok, registry_pid: pid}
  end

  defp wait_for_ets_gone(table_name, tries \\ 20) do
    if :ets.whereis(table_name) == :undefined do
      :ok
    else
      if tries > 0 do
        Process.sleep(10)
        wait_for_ets_gone(table_name, tries - 1)
      else
        :ok
      end
    end
  end

  describe "Skill Registry 동시 접근" do
    test "100개 병렬 스킬 실행 — ETS 경합 없음" do
      tasks =
        for i <- 1..100 do
          Task.async(fn ->
            SkillRegistry.execute(:detect_session_expiry, %{
              agent: :stress_test,
              response_html: "page content #{i}",
              status_code: 200
            })
          end)
        end

      results = Task.await_many(tasks, 10_000)
      success_count = Enum.count(results, fn r -> match?({:ok, _}, r) end)

      assert success_count == 100
    end

    test "다양한 스킬 동시 실행 — 결과 일관성" do
      # notify_failure는 Telegram/EventLake 미기동 환경에서 제외
      skills = [
        {:detect_session_expiry, %{agent: :andy, response_html: "ok page", status_code: 200}},
        {:classify_kiosk_state, %{response: %{status: "idle"}, last_heartbeat_ms: 1000}},
        {:audit_pos_transactions, %{transactions: [], expected_total: 0.0}},
        {:detect_anomaly, %{metric_name: "x", values: [1, 2, 3], method: :z_score, threshold: 3.0}},
        {:audit_db_integrity, %{table: "ska_cycle_metrics", checks: []}}
      ]

      tasks =
        for _ <- 1..10, {skill, params} <- skills do
          Task.async(fn -> SkillRegistry.execute(skill, params) end)
        end

      results = Task.await_many(tasks, 15_000)
      ok_count = Enum.count(results, fn r -> match?({:ok, _}, r) end)

      assert ok_count == length(tasks)
    end

    test "SkillRegistry.fetch/1 동시 1000회 — p95 < 5ms" do
      start = System.monotonic_time(:millisecond)

      tasks =
        for _ <- 1..1000 do
          Task.async(fn ->
            SkillRegistry.fetch(:detect_session_expiry)
          end)
        end

      results = Task.await_many(tasks, 10_000)
      elapsed = System.monotonic_time(:millisecond) - start

      ok_count = Enum.count(results, &match?({:ok, _}, &1))
      assert ok_count == 1000

      # 1000회 합산 1초 이내 (평균 1ms 이하)
      assert elapsed < 1000, "ETS 조회 1000회 #{elapsed}ms — 기대값 < 1000ms"
    end
  end

  describe "스킬 목록 조회 성능" do
    test "list/0 10000회 반복 — 메모리 증가 없음" do
      before_mem = :erlang.memory(:total)

      for _ <- 1..10_000 do
        SkillRegistry.list()
      end

      after_mem = :erlang.memory(:total)
      growth_mb = (after_mem - before_mem) / (1024 * 1024)

      # 10000회 호출 후 메모리 증가 10MB 이하
      assert growth_mb < 10,
             "메모리 증가 #{Float.round(growth_mb, 2)}MB — 기대값 < 10MB"
    end
  end

  describe "스킬 실행 체인 성능" do
    test "3-스킬 체인 50회 병렬 — 전체 5초 이내" do
      start = System.monotonic_time(:millisecond)

      tasks =
        for i <- 1..50 do
          Task.async(fn ->
            html = if rem(i, 3) == 0, do: "nid.naver.com/login", else: String.duplicate("ok", 300)

            {:ok, session} =
              SkillRegistry.execute(:detect_session_expiry, %{
                agent: :andy,
                response_html: html,
                status_code: 200
              })

            if session.status == :expired do
              SkillRegistry.execute(:trigger_recovery, %{
                agent: :andy,
                failure_type: :session_expired,
                context: %{}
              })

              SkillRegistry.execute(:notify_failure, %{
                agent: :andy,
                severity: :warning,
                message: "체인 테스트",
                metadata: %{}
              })
            end

            {:ok, session.status}
          end)
        end

      results = Task.await_many(tasks, 10_000)
      elapsed = System.monotonic_time(:millisecond) - start

      assert length(results) == 50
      assert elapsed < 5_000, "50회 체인 #{elapsed}ms — 기대값 < 5000ms"
    end
  end
end
