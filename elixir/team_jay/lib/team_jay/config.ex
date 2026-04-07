defmodule TeamJay.Config do
  def db_name, do: Application.get_env(:team_jay, TeamJay.Repo)[:database]
  def db_user, do: Application.get_env(:team_jay, TeamJay.Repo)[:username]
  def db_pass, do: Application.get_env(:team_jay, TeamJay.Repo)[:password]
  def db_host, do: Application.get_env(:team_jay, TeamJay.Repo)[:hostname]
  def hub_url, do: Application.get_env(:team_jay, :hub_url)
  def hub_token, do: Application.get_env(:team_jay, :hub_token)
  def pg_notify_channel, do: Application.get_env(:team_jay, :pg_notify_channel, "event_lake_insert")

  def notification_db_opts do
    opts = [hostname: db_host(), database: db_name(), username: db_user()]

    case db_pass() do
      nil -> opts
      "" -> opts
      password -> Keyword.put(opts, :password, password)
    end
  end
end
