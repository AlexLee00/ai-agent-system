defmodule TeamJay.Claude.Codex.CodexExecutor do
  @moduledoc """
  Deprecated compatibility shim.

  Direct execution of `docs/codex/CODEX_*.md` is disabled. Create actionable
  implementation requests in `docs/auto_dev` so the single Claude auto-dev
  pipeline can handle analysis, implementation, review, tests, and archival.
  """

  require Logger

  def execute(codex_path) do
    Logger.warning(
      "[CodexExecutor] ignored execute for #{Path.basename(codex_path)}: docs/codex execution is decommissioned"
    )

    {:error, :codex_executor_decommissioned}
  end

  def dry_run(codex_path) do
    case File.read(codex_path) do
      {:ok, content} ->
        summary =
          content
          |> String.split("\n")
          |> Enum.take(10)
          |> Enum.filter(&String.starts_with?(&1, ">"))
          |> Enum.map(&String.trim_leading(&1, "> "))
          |> Enum.join(" | ")

        {:ok,
         %{
           codex: Path.basename(codex_path),
           summary: summary,
           status: :decommissioned,
           next_step: "Move actionable implementation requests to docs/auto_dev"
         }}

      {:error, reason} ->
        {:error, reason}
    end
  end
end
