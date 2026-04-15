defmodule TeamJay.Teams.BlogShadowSupervisor do
  use Supervisor

  @blog_agents [
    %{name: :blog_collect_views, label: "ai.blog.collect-views", required: false},
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
        {TeamJay.Agents.LaunchdShadowAgent,
         name: agent.name,
         team: :blog,
         label: agent.label,
         required: Map.get(agent, :required, true)}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
  end
end
