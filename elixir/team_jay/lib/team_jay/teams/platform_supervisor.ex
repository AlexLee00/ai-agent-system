defmodule TeamJay.Teams.PlatformSupervisor do
  use Supervisor

  @platform_agents [
    %{
      name: :hub_resource_api,
      script: "dist/ts-runtime/bots/hub/src/hub.js",
      schedule: if(Mix.env() == :test, do: nil, else: :once),
      health_url: "http://127.0.0.1:7788/hub/health"
    }
  ]

  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children =
      Enum.map(@platform_agents, fn agent ->
        {TeamJay.Agents.PortAgent,
         name: agent.name,
         team: :platform,
         script: agent.script,
         schedule: agent.schedule,
         health_url: Map.get(agent, :health_url)}
      end)

    Supervisor.init(children, strategy: :one_for_one, max_restarts: 3, max_seconds: 60)
  end
end
