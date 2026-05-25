defmodule TeamJay.Blog.ReadOnlyRuntime do
  @moduledoc """
  Minimal runtime for blog reporting Mix tasks.

  These tasks only need configuration, JSON support, and a Repo connection.
  Starting the full TeamJay OTP tree also starts PortAgents and dashboard
  listeners, which makes read-only health checks mutate operational telemetry.
  """

  def start! do
    for app <- [:postgrex, :ecto, :ecto_sql, :jason] do
      {:ok, _started} = Application.ensure_all_started(app)
    end

    ensure_repo_started!()
  end

  defp ensure_repo_started! do
    case Process.whereis(Jay.Core.Repo) do
      nil ->
        db_config = Application.get_env(:team_jay, Jay.Core.Repo)
        {:ok, _pid} = Jay.Core.Repo.start_link(db_config)
        :ok

      _pid ->
        :ok
    end
  end
end
