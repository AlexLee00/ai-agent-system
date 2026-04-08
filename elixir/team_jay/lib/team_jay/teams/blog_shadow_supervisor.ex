defmodule TeamJay.Teams.BlogShadowSupervisor do
  use Supervisor

  @blog_agents [
    %{name: :blog_daily, label: "ai.blog.daily"},
    %{name: :blog_commenter, label: "ai.blog.commenter"},
    %{name: :blog_collect_performance, label: "ai.blog.collect-performance"},
    %{name: :blog_collect_competition, label: "ai.blog.collect-competition"},
    %{name: :blog_collect_views, label: "ai.blog.collect-views"},
    %{name: :blog_health_check, label: "ai.blog.health-check"},
    %{name: :blog_node_server, label: "ai.blog.node-server"}
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@blog_agents, fn agent ->
        {TeamJay.Agents.LaunchdShadowAgent, name: agent.name, team: :blog, label: agent.label}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
  end
end
