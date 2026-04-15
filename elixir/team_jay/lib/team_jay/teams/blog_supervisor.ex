defmodule TeamJay.Teams.BlogSupervisor do
  use Supervisor

  @blog_agents [
    %{name: :blog_commenter, script: "bots/blog/scripts/run-commenter.ts", schedule: {:interval, 2_160_000}}
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@blog_agents, fn agent ->
        {TeamJay.Agents.PortAgent,
         name: agent.name, team: :blog, script: agent.script, schedule: agent.schedule}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 5, max_seconds: 60)
  end
end
