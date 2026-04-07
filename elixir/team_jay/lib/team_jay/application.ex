defmodule TeamJay.Application do
  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    Logger.info("🚀 TeamJay Elixir 시작!")

    children = [
      TeamJay.Repo,
      TeamJay.EventListener,
      TeamJay.Teams.SkaSupervisor
    ]

    opts = [strategy: :one_for_one, name: TeamJay.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
