defmodule Mix.Tasks.Luna.Migrate do
  @moduledoc "루나팀 DB 마이그레이션 실행 (investment 스키마)"
  use Mix.Task
  require Logger

  @shortdoc "루나팀 investment 스키마 마이그레이션"

  @migration_dir Path.expand("../../../../../bots/investment/migrations", __DIR__)

  def run(_args) do
    Application.ensure_all_started(:postgrex)
    Application.ensure_all_started(:ecto_sql)
    Jay.Core.Repo.start_link([])

    migration_files =
      @migration_dir
      |> File.ls!()
      |> Enum.filter(&String.ends_with?(&1, ".sql"))
      |> Enum.sort()

    Logger.info("[luna.migrate] #{length(migration_files)}개 마이그레이션 파일 발견")

    Enum.each(migration_files, fn file ->
      path = Path.join(@migration_dir, file)
      sql  = File.read!(path)
      Logger.info("[luna.migrate] 실행 중: #{file}")
      case Jay.Core.Repo.query(sql, []) do
        {:ok, _}         -> Logger.info("[luna.migrate] ✓ #{file}")
        {:error, reason} -> Logger.error("[luna.migrate] ✗ #{file}: #{inspect(reason)}")
      end
    end)

    Logger.info("[luna.migrate] 완료")
  end
end
