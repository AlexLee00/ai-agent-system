defmodule TeamJay.Application do
  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    Logger.info("🚀 TeamJay Elixir Phase 4 시작! (Jay 성장 오케스트레이터)")

    children = [
      TeamJay.Repo,
      {Registry, keys: :unique, name: TeamJay.AgentRegistry},
      {Registry, keys: :duplicate, name: TeamJay.InvestmentBus},
      {Registry, keys: :duplicate, name: TeamJay.BlogBus},
      {Registry, keys: :duplicate, name: TeamJay.SkaBus},
      {Registry, keys: :duplicate, name: TeamJay.JayBus},
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
      TeamJay.Blog.TokenRenewal,
      TeamJay.Blog.PublishGuard,
      TeamJay.Blog.TopicPlanner,
      TeamJay.Blog.TopicCurator,
      TeamJay.Blog.CommandInbox,
      TeamJay.Blog.InsightsCollector,
      TeamJay.Blog.StrategyLearner,
      TeamJay.Blog.ContentLoop,
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
      TeamJay.Teams.JaySupervisor,
      TeamJay.Diagnostics,
      TeamJay.Scheduler
    ]

    opts = [strategy: :one_for_one, name: TeamJay.Supervisor]
    result = Supervisor.start_link(children, opts)

    Task.start(fn ->
      :timer.sleep(2_000)

      _ =
        TeamJay.HubClient.post_alarm(
          "🚀 Elixir Phase 4 시작!\n🎯 Jay 성장 오케스트레이터 활성화\n🔄 9팀 일일 환류 사이클 (06:30 KST)\n⚡ 팀 간 파이프라인 7개 준비\n📊 JayBus PubSub 가동",
          "system",
          "elixir"
        )
    end)

    result
  end
end
