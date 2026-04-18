defmodule TeamJay.Ska.MapeKLoopTest do
  use ExUnit.Case, async: true
  alias TeamJay.Ska.MapeKLoop

  describe "init/1" do
    test "Kill Switch OFF 시 dormant 상태로 시작" do
      System.put_env("SKA_MAPEK_ENABLED", "false")

      {:ok, pid} = GenServer.start_link(MapeKLoop, [], name: nil)
      state = :sys.get_state(pid)
      assert state.dormant == true
      GenServer.stop(pid)
    end
  end

  describe "status/0 — 등록된 서버 대상" do
    test "Kill Switch OFF 상태는 dormant 반환" do
      System.put_env("SKA_MAPEK_ENABLED", "false")
      {:ok, pid} = GenServer.start_link(MapeKLoop, [], name: nil)
      state = GenServer.call(pid, :status)
      assert state[:dormant] == true
      GenServer.stop(pid)
    end
  end
end
