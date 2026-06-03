defmodule Mix.Tasks.Sigma.Daily.Autonomous do
  use Mix.Task
  require Logger

  @shortdoc "Sigma V2 완전자율 일일 실행 (MAPE-K 실사이클)"

  # app.start는 TeamJay 전체 트리를 기동해 Claude/Blog/Ska
  # PortAgent까지 깨운다. Sigma daily는 Sigma MAPE-K에 필요한 최소 런타임만
  # 올려야 LLM/프로세스 누수가 생기지 않는다.
  @requirements ["app.config"]

  @impl Mix.Task
  def run(_args) do
    if mapek_enabled?() do
      start_sigma_runtime!()
      run_autonomous_cycle!()
    else
      Logger.error("[sigma_autonomous] 실패: :mapek_disabled")
      IO.puts(Jason.encode!(%{ok: false, mode: "autonomous", error: ":mapek_disabled"}))
      System.stop(1)
    end
  end

  defp run_autonomous_cycle! do
    date = Date.utc_today()
    Logger.info("[sigma_autonomous] #{date} 자율 실행 시작")

    case Sigma.V2.MapeKLoop.run_cycle_sync() do
      {:ok, result} ->
        cycle_id = result[:cycle_id]
        success = result[:success_count] || 0
        error = result[:error_count] || 0

        Logger.info(
          "[sigma_autonomous] 완료 cycle_id=#{cycle_id} success=#{success} error=#{error}"
        )

        IO.puts(
          Jason.encode!(%{
            ok: true,
            mode: "autonomous",
            date: date,
            cycle_id: cycle_id,
            success_count: success,
            error_count: error
          })
        )

      {:error, reason} ->
        Logger.error("[sigma_autonomous] 실패: #{inspect(reason)}")
        IO.puts(Jason.encode!(%{ok: false, mode: "autonomous", error: inspect(reason)}))
        System.stop(1)
    end
  end

  defp start_sigma_runtime! do
    for app <- [:postgrex, :ecto, :ecto_sql, :jason, :mime, :finch, :req, :phoenix_pubsub] do
      Application.ensure_all_started(app)
    end

    ensure_repo_started!()
    ensure_named_child_started!(Sigma.V2.PubSub, {Phoenix.PubSub, name: Sigma.V2.PubSub})
    ensure_named_child_started!(Sigma.V2.Memory.L1, Sigma.V2.Memory.L1)
    ensure_named_child_started!(Sigma.V2.MapeKLoop, Sigma.V2.MapeKLoop)
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

  defp ensure_named_child_started!(name, child_spec) do
    case Process.whereis(name) do
      nil ->
        {:ok, _pid} = start_child(child_spec)
        :ok

      _pid ->
        :ok
    end
  end

  defp start_child({Phoenix.PubSub, opts}) do
    Supervisor.start_link([{Phoenix.PubSub, opts}],
      strategy: :one_for_one,
      name: Sigma.V2.MinimalPubSubSupervisor
    )
  end

  defp start_child({module, opts}), do: module.start_link(opts)
  defp start_child(module), do: module.start_link([])

  defp mapek_enabled? do
    System.get_env("SIGMA_V2_ENABLED") == "true" and
      System.get_env("SIGMA_MAPEK_ENABLED") == "true"
  end
end
