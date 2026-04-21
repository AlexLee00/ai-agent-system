defmodule Mix.Tasks.Sigma.Daily.Autonomous do
  use Mix.Task
  require Logger

  @shortdoc "Sigma V2 완전자율 일일 실행 (MAPE-K 실사이클)"

  @requirements ["app.start"]

  @impl Mix.Task
  def run(_args) do
    date = Date.utc_today()
    Logger.info("[sigma_autonomous] #{date} 자율 실행 시작")

    case Sigma.V2.MapeKLoop.run_cycle_sync() do
      {:ok, result} ->
        cycle_id = result[:cycle_id]
        success = result[:success_count] || 0
        error = result[:error_count] || 0

        Logger.info("[sigma_autonomous] 완료 cycle_id=#{cycle_id} success=#{success} error=#{error}")

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
end
