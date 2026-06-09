defmodule Mix.Tasks.Jay.GrowthCycle.Run do
  @moduledoc """
  TeamJay 전체 OTP 트리를 띄우지 않고 Jay GrowthCycle을 단발 실행한다.

  대시보드 Endpoint가 이미 7787을 점유한 운영 환경에서 launchd가 안전하게
  `growth_cycle.measured` 이벤트를 만들기 위한 전용 진입점이다.
  """

  use Mix.Task

  @shortdoc "Run Jay GrowthCycle once without starting the dashboard endpoint"

  @impl Mix.Task
  def run(args) do
    Mix.Task.run("app.config")
    start_minimal_runtime!()

    result =
      args
      |> parse_opts()
      |> Jay.V2.GrowthCycle.run_cycle_sync()

    Mix.shell().info(Jason.encode!(result))
  end

  defp parse_opts(args) do
    Enum.reduce(args, [], fn
      "--no-notify", opts -> Keyword.put(opts, :notify, false)
      "--no-clean-day", opts -> Keyword.put(opts, :record_clean_day, false)
      "--no-actions", opts -> Keyword.put(opts, :execute_actions, false)
      "--json", opts -> opts
      "--dry-run", opts -> opts
      "--fixture", opts -> opts
      "--slot", opts -> opts
      "--" <> _unknown, opts -> opts
      "date=" <> date, opts -> Keyword.put(opts, :date, date)
      "--date=" <> date, opts -> Keyword.put(opts, :date, date)
      _other, opts -> opts
    end)
  end

  defp start_minimal_runtime! do
    Enum.each([:ssl, :postgrex, :ecto, :ecto_sql, :jason, :req], &ensure_started!/1)
    start_repo!()
    start_registry!(Jay.Core.JayBus, :duplicate)
    start_process!(Jay.V2.AutonomyController)
  end

  defp ensure_started!(app) do
    case Application.ensure_all_started(app) do
      {:ok, _} -> :ok
      {:error, {:already_started, _}} -> :ok
      {:error, reason} -> Mix.raise("failed to start #{inspect(app)}: #{inspect(reason)}")
    end
  end

  defp start_repo! do
    case Process.whereis(Jay.Core.Repo) do
      nil ->
        case Jay.Core.Repo.start_link() do
          {:ok, _pid} -> :ok
          {:error, {:already_started, _pid}} -> :ok
          {:error, reason} -> Mix.raise("failed to start Jay.Core.Repo: #{inspect(reason)}")
        end

      _pid ->
        :ok
    end
  end

  defp start_registry!(name, keys) do
    case Process.whereis(name) do
      nil ->
        case Registry.start_link(keys: keys, name: name) do
          {:ok, _pid} -> :ok
          {:error, {:already_started, _pid}} -> :ok
          {:error, reason} -> Mix.raise("failed to start #{inspect(name)}: #{inspect(reason)}")
        end

      _pid ->
        :ok
    end
  end

  defp start_process!(module) do
    case Process.whereis(module) do
      nil ->
        case module.start_link([]) do
          {:ok, _pid} -> :ok
          {:error, {:already_started, _pid}} -> :ok
          {:error, reason} -> Mix.raise("failed to start #{inspect(module)}: #{inspect(reason)}")
        end

      _pid ->
        :ok
    end
  end
end
