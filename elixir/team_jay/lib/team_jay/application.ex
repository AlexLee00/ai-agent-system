defmodule TeamJay.Application do
  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    Logger.info("🚀 TeamJay Elixir Phase 4 시작! (Jay 성장 오케스트레이터)")

    children =
      base_children() ++
        if(enable_diagnostics?(), do: [Jay.Core.Diagnostics], else: []) ++
        [Jay.Core.Scheduler]

    opts = [strategy: :one_for_one, name: TeamJay.Supervisor]
    result = Supervisor.start_link(children, opts)

    result
  end

  defp base_children do
    [
      Jay.Core.Repo,
      {Registry, keys: :unique, name: TeamJay.AgentRegistry},
      {Registry, keys: :duplicate, name: TeamJay.InvestmentBus},
      {Registry, keys: :duplicate, name: TeamJay.BlogBus},
      {Registry, keys: :duplicate, name: TeamJay.SkaBus},
      Jay.Core.JayBus,
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
      TeamJay.Blog.CommandActionHandler,
      TeamJay.Investment.CommandInbox,
      TeamJay.Investment.CommandActionHandler,
      TeamJay.Blog.InsightsCollector,
      TeamJay.Blog.StrategyLearner,
      TeamJay.Blog.ContentLoop,
      Jay.Core.EventLake,
      Jay.Core.MarketRegime,
      TeamJay.Ska.CommandInbox,
      TeamJay.Ska.CommandActionHandler,
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
      Jay.V2.Supervisor,
      Sigma.V2.Supervisor,
      Darwin.V2.Supervisor
    ]
  end

  defp enable_diagnostics? do
    force = String.downcase(String.trim(System.get_env("TEAM_JAY_ENABLE_DIAGNOSTICS", "")))

    cond do
      force in ["1", "true", "yes"] ->
        true

      force in ["0", "false", "no"] ->
        false

      Mix.env() == :test ->
        true

      true ->
        Node.alive?()
    end
  end

end
