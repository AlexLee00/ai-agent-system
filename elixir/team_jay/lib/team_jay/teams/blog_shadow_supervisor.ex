defmodule TeamJay.Teams.BlogShadowSupervisor do
  use Supervisor

  @blog_agents [
    %{name: :blog_health_check, label: "ai.blog.health-check"}
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
