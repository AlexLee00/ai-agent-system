defmodule TeamJay.Config do
  def db_name, do: Application.get_env(:team_jay, TeamJay.Repo)[:database]
  def db_user, do: Application.get_env(:team_jay, TeamJay.Repo)[:username]
  def db_pass, do: Application.get_env(:team_jay, TeamJay.Repo)[:password]
  def db_host, do: Application.get_env(:team_jay, TeamJay.Repo)[:hostname]
  def hub_url, do: Application.get_env(:team_jay, :hub_url) || launchctl_env("TEAM_JAY_HUB_URL") || launchctl_env("HUB_BASE_URL")
  def hub_token, do: Application.get_env(:team_jay, :hub_token) || launchctl_env("TEAM_JAY_HUB_TOKEN") || launchctl_env("HUB_AUTH_TOKEN")
  def pg_notify_channel, do: Application.get_env(:team_jay, :pg_notify_channel, "event_lake_insert")
  def repo_root, do: Application.get_env(:team_jay, :repo_root, "/Users/alexlee/projects/ai-agent-system")

  def notification_db_opts do
    opts = [hostname: db_host(), database: db_name(), username: db_user()]

    case db_pass() do
      nil -> opts
      "" -> opts
      password -> Keyword.put(opts, :password, password)
    end
  end

  defp launchctl_env(name) do
    case System.cmd("launchctl", ["getenv", name], stderr_to_stdout: true) do
      {value, 0} ->
        value
        |> String.trim()
        |> case do
          "" -> nil
          trimmed -> trimmed
        end

      _ ->
        nil
    end
  end
end
