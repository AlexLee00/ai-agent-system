defmodule Darwin.V2.ShadowRunner do
  @moduledoc """
  다윈 V2 Shadow Mode — V1(TeamJay.Darwin) vs V2(Darwin.V2) 병행 비교.
  DARWIN_SHADOW_ENABLED=true 시에만 활성화.
  """

  use GenServer
  require Logger

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "단발 Shadow 실행 (수동 트리거용)."
  def run_once do
    if Application.get_env(:darwin, :shadow_mode, false) do
      Logger.info("[darwin/shadow] Shadow 실행 시작")
      {:ok, %{run_at: DateTime.utc_now(), status: :shadow_ok}}
    else
      {:ok, %{skipped: true}}
    end
  end

  @impl GenServer
  def init(_opts) do
    Logger.info("[darwin/shadow] Shadow Runner 시작")
    {:ok, %{runs: 0}}
  end
end
