defmodule Mix.Tasks.Sigma.Migrate do
  @shortdoc "시그마 + 기본 마이그레이션 통합 실행 (두 경로)"
  @moduledoc """
  두 마이그레이션 경로를 순서대로 실행:
    1. priv/repo/migrations (team_jay 기본)
    2. bots/sigma/migrations (Sigma V2 전용)

  ## 사용법

      mix sigma.migrate
      mix sigma.migrate --env prod
      mix sigma.migrate --quiet

  ## 배경

  Sigma V2 마이그레이션이 별도 경로에 있어 `mix ecto.migrate` 단독으로는
  두 경로를 함께 실행할 수 없음. 이 태스크가 통합 실행을 담당.
  """

  use Mix.Task

  require Logger

  @sigma_migrations_rel "../../bots/sigma/migrations"

  @impl Mix.Task
  def run(args) do
    Mix.Task.run("app.start", [])

    repo = TeamJay.Repo
    base_dir = Path.expand("priv/repo/migrations", Mix.Project.app_path())
    sigma_dir = Path.expand(@sigma_migrations_rel, File.cwd!())

    quiet = "--quiet" in args

    run_path(repo, base_dir, quiet, "team_jay 기본")
    run_path(repo, sigma_dir, quiet, "Sigma V2")
  end

  defp run_path(repo, path, quiet, label) do
    unless quiet do
      Mix.shell().info("==> [sigma.migrate] #{label}: #{path}")
    end

    if File.dir?(path) do
      migrated =
        Ecto.Migrator.run(repo, path, :up, all: true, log: not quiet)

      count = length(List.wrap(migrated))

      unless quiet do
        Mix.shell().info("==> [sigma.migrate] #{label}: #{count}건 마이그레이션 완료")
      end
    else
      Mix.shell().error("==> [sigma.migrate] 경로 없음 (skip): #{path}")
    end
  end
end
