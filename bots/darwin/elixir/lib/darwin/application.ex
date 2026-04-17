defmodule Darwin.Application do
  @moduledoc """
  Darwin 독립 OTP 애플리케이션 — V2 에이전트 트리 진입점.

  DARWIN_V2_ENABLED=true 일 때만 전체 수퍼바이저 트리 기동.
  비활성 상태에서는 최소 프로세스만 유지 (비용 $0).
  """

  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    if Application.get_env(:darwin, :v2_enabled, false) do
      Logger.info("[다윈V2] V2 활성화 — 수퍼바이저 트리 기동")
      start_v2()
    else
      Logger.info("[다윈V2] V2 비활성 — 대기 모드")
      # V2 비활성 시 최소 감독 트리만 구성 (재시작 없이 유지)
      children = []
      opts = [strategy: :one_for_one, name: Darwin.Supervisor]
      Supervisor.start_link(children, opts)
    end
  end

  defp start_v2 do
    # Telemetry 핸들러를 수퍼바이저 기동 전에 등록
    Darwin.V2.Telemetry.setup()

    children = [Darwin.V2.Supervisor]
    opts = [strategy: :one_for_one, name: Darwin.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
