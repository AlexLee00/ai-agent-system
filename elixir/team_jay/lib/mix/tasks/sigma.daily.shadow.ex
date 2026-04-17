defmodule Mix.Tasks.Sigma.Daily.Shadow do
  use Mix.Task
  require Logger

  @shortdoc "Sigma Shadow Mode 일일 실행 (v2 Commander vs v1 baseline 비교)"

  # app.config만 로드하고 필요한 앱만 수동 시작 (전체 앱 기동 방지)
  @requirements ["app.config"]

  @impl Mix.Task
  def run(_args) do
    # HTTP + DB + JSON 최소 스택
    for app <- [:postgrex, :ecto, :ecto_sql, :jason, :mime, :finch, :req] do
      Application.ensure_all_started(app)
    end

    db_config = Application.get_env(:team_jay, TeamJay.Repo)
    {:ok, _pid} = TeamJay.Repo.start_link(db_config)

    date = Date.utc_today()
    Logger.info("[sigma_shadow] #{date} Shadow 실행 시작")

    case Sigma.V2.ShadowRunner.run(%{date: date}) do
      {:ok, result} ->
        match = result[:match_score]
        id = result[:shadow_run_id]
        Logger.info("[sigma_shadow] 완료 id=#{id} match_score=#{match}")
        IO.puts(Jason.encode!(%{ok: true, date: date, match_score: match, shadow_run_id: id}))

      {:error, reason} ->
        Logger.error("[sigma_shadow] 실패: #{inspect(reason)}")
        IO.puts(Jason.encode!(%{ok: false, error: inspect(reason)}))
        System.stop(1)
    end
  end
end
