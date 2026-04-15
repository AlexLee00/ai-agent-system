defmodule TeamJay.Teams.BlogSupervisor do
  use Supervisor

  @blog_agents [
    %{name: :blog_commenter, script: "bots/blog/scripts/run-commenter.ts", schedule: {:interval, 2_160_000}},
    %{name: :blog_daily, script: "bots/blog/scripts/run-daily.ts", schedule: {:daily_at, 6, 0}},
    %{name: :blog_collect_performance, script: "bots/blog/scripts/collect-performance.ts", schedule: {:daily_at, 21, 0}},
    %{name: :blog_collect_competition, script: "bots/blog/scripts/collect-competition-results.ts", schedule: {:weekly_at, [1, 3, 5], 22, 0}},
    %{name: :blog_weekly_evolution, script: "bots/blog/scripts/weekly-evolution.ts", schedule: {:weekly_at, [1], 21, 30}},
    %{name: :blog_sync_book_catalog, script: "bots/blog/scripts/sync-book-catalog.ts --json", schedule: {:daily_at, 5, 40}},
    %{name: :blog_sync_book_review_queue, script: "bots/blog/scripts/build-book-review-queue.ts --json --limit 5", schedule: {:daily_at, 5, 50}},
    %{name: :blog_collect_views, script: "bots/blog/scripts/collect-views.ts", schedule: {:daily_at, 23, 0}},
    %{
      name: :blog_marketing_snapshot,
      script: "export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH && cd elixir/team_jay && mix blog.marketing.snapshot",
      runner: {:shell, "/bin/zsh"},
      schedule: {:daily_at, 6, 30}
    },
    %{
      name: :blog_marketing_report,
      script: "export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH && cd elixir/team_jay && mix blog.marketing.notify --brief --send",
      runner: {:shell, "/bin/zsh"},
      schedule: {:daily_at, 6, 35}
    }
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@blog_agents, fn agent ->
        {TeamJay.Agents.PortAgent,
         name: agent.name,
         team: :blog,
         script: agent.script,
         runner: Map.get(agent, :runner, :node),
         schedule: agent.schedule}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
  end
end
