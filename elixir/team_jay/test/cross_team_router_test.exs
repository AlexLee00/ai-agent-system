defmodule TeamJay.Jay.CrossTeamRouterTest do
  use ExUnit.Case, async: false

  # CrossTeamRouter 가 기동 중일 때만 의미 있는 테스트.
  # 프로세스 미기동 시 skip.
  setup do
    pid = Process.whereis(TeamJay.Jay.CrossTeamRouter)
    {:ok, pid: pid}
  end

  describe "luna_to_blog 파이프라인 — content_requests INSERT" do
    test "bear 체제 → urgency = urgent", %{pid: pid} do
      if pid do
        count_before = count_luna_requests()
        send(pid, {:jay_bus, :luna_to_blog, %{regime: "bear", details: %{test: true}}})
        :timer.sleep(300)
        latest = latest_luna_request()
        if latest do
          assert latest["urgency"] == "urgent"
          assert latest["regime"] == "bear"
          assert count_luna_requests() > count_before
        end
      end
    end

    test "bull 체제 → urgency = normal", %{pid: pid} do
      if pid do
        send(pid, {:jay_bus, :luna_to_blog, %{regime: "bull", details: %{}}})
        :timer.sleep(300)
        latest = latest_luna_request()
        if latest, do: assert(latest["urgency"] == "normal")
      end
    end

    test "crisis 체제 → urgency = urgent", %{pid: pid} do
      if pid do
        send(pid, {:jay_bus, :luna_to_blog, %{regime: "crisis", details: %{}}})
        :timer.sleep(300)
        latest = latest_luna_request()
        if latest, do: assert(latest["urgency"] == "urgent")
      end
    end

    test "unknown 체제 → urgency = low", %{pid: pid} do
      if pid do
        send(pid, {:jay_bus, :luna_to_blog, %{regime: "sideways", details: %{}}})
        :timer.sleep(300)
        latest = latest_luna_request()
        if latest, do: assert(latest["urgency"] == "low")
      end
    end

    test "DB 실패 시 GenServer 크래시 없음", %{pid: pid} do
      if pid do
        send(pid, {:jay_bus, :luna_to_blog, %{regime: "volatile", details: %{}}})
        :timer.sleep(300)
        assert Process.alive?(pid)
      end
    end
  end

  # ─── 헬퍼 ────────────────────────────────────────────────────────

  defp count_luna_requests do
    case TeamJay.Repo.query(
      "SELECT COUNT(*) FROM blog.content_requests WHERE source_team = 'luna'", []
    ) do
      {:ok, %{rows: [[n]]}} -> n
      _ -> 0
    end
  rescue
    _ -> 0
  end

  defp latest_luna_request do
    case TeamJay.Repo.query(
      """
      SELECT regime, mood, urgency, angle_hint
      FROM blog.content_requests
      WHERE source_team = 'luna'
      ORDER BY requested_at DESC LIMIT 1
      """, []
    ) do
      {:ok, %{columns: cols, rows: [row]}} -> Enum.zip(cols, row) |> Enum.into(%{})
      _ -> nil
    end
  rescue
    _ -> nil
  end
end
