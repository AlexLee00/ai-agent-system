defmodule Sigma.LunaDataIngestor do
  @moduledoc """
  Command builder for the Sigma <-> Luna learning bridge.

  The Elixir side keeps orchestration explicit: it returns the runtime commands
  to execute, but does not touch live trading, secrets, launchctl, or processes.
  """

  @spec feed_command(keyword()) :: [String.t()]
  def feed_command(opts \\ []) do
    limit = Keyword.get(opts, :limit, 50)
    mode = if Keyword.get(opts, :write, false), do: ["--write", "--no-dry-run"], else: []

    ["npm", "run", "-s", "luna:feed", "--", "--json", "--limit=#{limit}"] ++ mode
  end

  @spec feedback_command(keyword()) :: [String.t()]
  def feedback_command(opts \\ []) do
    limit = Keyword.get(opts, :limit, 20)
    mode = if Keyword.get(opts, :write, false), do: ["--write", "--no-dry-run"], else: []

    ["npm", "run", "-s", "luna:feedback", "--", "--json", "--limit=#{limit}"] ++ mode
  end

  @spec bridge_plan() :: map()
  def bridge_plan do
    %{
      name: "sigma_luna_learning_bridge",
      live_trade: false,
      secret_change: false,
      commands: %{
        feed_dry_run: feed_command(),
        feedback_dry_run: feedback_command(),
        feed_write: feed_command(write: true),
        feedback_write: feedback_command(write: true)
      }
    }
  end
end
