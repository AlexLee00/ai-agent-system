defmodule Jay.Application do
  @moduledoc """
  Jay Application — 제이팀 성장 오케스트레이터 진입점.
  Jay.Core.Repo / Jay.Core.JayBus는 team_jay Application에서 기동하므로 여기선 시작하지 않는다.
  """

  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    Logger.info("[Jay Application] 기동 — 9팀 성장 오케스트레이터")

    children = [
      Jay.V2.Supervisor
    ]

    opts = [strategy: :one_for_one, name: Jay.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
