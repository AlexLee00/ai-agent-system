defmodule TeamJay.Teams.BlogSupervisor do
  use Supervisor

  @blog_agents [
    # blog 주기 작업은 launchd가 canonical owner다.
    # PortAgent는 수동 실행/호환성 용도로만 남기고 schedule은 비운다.
    %{name: :blog_commenter, script: "bots/blog/scripts/run-commenter.ts", schedule: nil},
    %{name: :blog_daily, script: "bots/blog/scripts/run-daily.ts", schedule: nil},
    %{name: :blog_collect_performance, script: "bots/blog/scripts/collect-performance.ts", schedule: nil},
    %{name: :blog_collect_competition, script: "bots/blog/scripts/collect-competition-results.ts", schedule: nil},
    %{name: :blog_weekly_evolution, script: "bots/blog/scripts/weekly-evolution.ts", schedule: nil},
    %{name: :blog_sync_book_catalog, script: "bots/blog/scripts/sync-book-catalog.ts --json", schedule: nil},
    %{name: :blog_sync_book_review_queue, script: "bots/blog/scripts/build-book-review-queue.ts --json --limit 5", schedule: nil},
    %{name: :blog_collect_views, script: "bots/blog/scripts/collect-views.ts", schedule: nil},
    %{name: :blog_channel_insights, script: "bots/blog/scripts/channel-insights-collector.ts --json", schedule: nil},
    %{name: :blog_revenue_strategy, script: "bots/blog/scripts/revenue-strategy-updater.ts --json", schedule: nil},
    %{
      name: :blog_node_server,
      script: "bots/blog/api/node-server.ts",
      runner: :tsx,
      schedule: if(Mix.env() == :test, do: nil, else: :once),
      health_url: "http://127.0.0.1:3100/health"
    },
    %{name: :blog_competitor_analysis, script: "bots/blog/scripts/run-competitor-analysis.ts --json", schedule: nil},
    %{
      name: :blog_marketing_snapshot,
      script: "export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH && cd elixir/team_jay && mix blog.marketing.snapshot",
      runner: {:shell, "/bin/zsh"},
      schedule: nil
    },
    %{
      name: :blog_marketing_report,
      script: "export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH && cd elixir/team_jay && mix blog.marketing.notify --brief --send",
      runner: {:shell, "/bin/zsh"},
      schedule: nil
    }
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@blog_agents, fn agent ->
        {Jay.Core.Agents.PortAgent,
         name: agent.name,
         team: :blog,
         script: agent.script,
         runner: Map.get(agent, :runner, :tsx),
         schedule: agent.schedule,
         health_url: Map.get(agent, :health_url)}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
  end

  @doc "ownership manifest와 대조할 Elixir-managed launch labels"
  def agent_labels do
    [
      "ai.blog.node-server"
    ]
  end
end
