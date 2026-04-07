defmodule TeamJay.Application do
  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    Logger.info("🚀 TeamJay Elixir Phase 2 시작!")

    children = [
      TeamJay.Repo,
      TeamJay.EventLake,
      TeamJay.MarketRegime,
      TeamJay.Teams.SkaSupervisor,
      TeamJay.Diagnostics
    ]

    opts = [strategy: :one_for_one, name: TeamJay.Supervisor]
    result = Supervisor.start_link(children, opts)

    Task.start(fn ->
      :timer.sleep(2_000)

      _ =
        TeamJay.HubClient.post_alarm(
          "🚀 Elixir Phase 2 시작!\n👥 스카팀 Supervisor 가동\n📡 EventLake 수신 중\n🌍 MarketRegime 감지 중\n🔍 Diagnostics 모니터링 중",
          "system",
          "elixir"
        )
    end)

    result
  end
end
