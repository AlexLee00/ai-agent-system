defmodule TeamJay.Application do
  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    Logger.info("🚀 TeamJay Elixir Phase 3 시작!")

    children = [
      TeamJay.Repo,
      {Registry, keys: :unique, name: TeamJay.AgentRegistry},
      {Registry, keys: :duplicate, name: TeamJay.InvestmentBus},
      {Registry, keys: :duplicate, name: TeamJay.BlogBus},
      TeamJay.Blog.Orchestrator,
      TeamJay.Blog.Researcher,
      TeamJay.Blog.Writer.Pos,
      TeamJay.Blog.Writer.Gems,
      TeamJay.Blog.Editor,
      TeamJay.Blog.Publisher,
      TeamJay.Blog.PortBridge,
      TeamJay.Blog.NodePublishAgent,
      TeamJay.Blog.NodePublishExecutor,
      TeamJay.Blog.NodePublishRunner,
      TeamJay.Blog.ExecutionMonitor,
      TeamJay.Blog.AlertRelay,
      TeamJay.Blog.Feedback,
      TeamJay.Blog.SocialRelay,
      TeamJay.Blog.InstagramAgent,
      TeamJay.Blog.InstagramExecutor,
      TeamJay.Blog.InstagramRunner,
      TeamJay.Blog.FacebookAgent,
      TeamJay.Blog.FacebookExecutor,
      TeamJay.Blog.FacebookRunner,
      TeamJay.Blog.NaverBlogAgent,
      TeamJay.Blog.NaverBlogExecutor,
      TeamJay.Blog.NaverBlogRunner,
      TeamJay.Blog.SocialExecutionMonitor,
      TeamJay.Blog.SocialAlertRelay,
      TeamJay.EventLake,
      TeamJay.MarketRegime,
      TeamJay.Teams.SkaSupervisor,
      TeamJay.Teams.ClaudeSupervisor,
      TeamJay.Teams.StewardSupervisor,
      TeamJay.Teams.InvestmentSupervisor,
      TeamJay.Teams.BlogSupervisor,
      TeamJay.Teams.WorkerSupervisor,
      TeamJay.Teams.PlatformSupervisor,
      TeamJay.Teams.BlogShadowSupervisor,
      TeamJay.Teams.WorkerShadowSupervisor,
      TeamJay.Teams.PlatformShadowSupervisor,
      TeamJay.Diagnostics,
      TeamJay.Scheduler
    ]

    opts = [strategy: :one_for_one, name: TeamJay.Supervisor]
    result = Supervisor.start_link(children, opts)

    Task.start(fn ->
      :timer.sleep(2_000)

      _ =
        TeamJay.HubClient.post_alarm(
          "🚀 Elixir Phase 3 Week3 시작!\n👥 Week1 Supervisor 유지 + Week2/3 Shadow 감시 확대\n📡 EventLake 수신 중\n🌍 MarketRegime 감지 중\n🔍 Diagnostics 모니터링 중",
          "system",
          "elixir"
        )
    end)

    result
  end
end
