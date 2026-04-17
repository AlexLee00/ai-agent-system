defmodule Mix.Tasks.Darwin.Migrate do
  @shortdoc "다윈 V2 + 기본 마이그레이션 통합 실행"
  @moduledoc """
  두 마이그레이션 경로를 순서대로 실행:
    1. priv/repo/migrations (team_jay 기본)
    2. bots/darwin/migrations (Darwin V2 전용)

  ## 사용법

      mix darwin.migrate
      mix darwin.migrate --quiet
  """

  use Mix.Task
  require Logger

  @darwin_migrations_rel "../../bots/darwin/migrations"

  @impl Mix.Task
  def run(args) do
    Mix.Task.run("app.start", [])

    repo = Jay.Core.Repo
    base_dir = Path.expand("priv/repo/migrations", Mix.Project.app_path())
    darwin_dir = Path.expand(@darwin_migrations_rel, File.cwd!())

    quiet = "--quiet" in args

    run_path(repo, base_dir, quiet, "team_jay 기본")
    run_path(repo, darwin_dir, quiet, "Darwin V2")
  end

  defp run_path(repo, path, quiet, label) do
    unless quiet do
      Mix.shell().info("==> [darwin.migrate] #{label}: #{path}")
    end

    if File.dir?(path) do
      migrated = Ecto.Migrator.run(repo, path, :up, all: true, log: not quiet)
      count = length(List.wrap(migrated))

      unless quiet do
        Mix.shell().info("==> [darwin.migrate] #{label}: #{count}건 마이그레이션 완료")
      end
    else
      Mix.shell().error("==> [darwin.migrate] 경로 없음 (skip): #{path}")
    end
  end
end
