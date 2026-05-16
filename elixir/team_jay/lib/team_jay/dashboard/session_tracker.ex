defmodule TeamJay.Dashboard.SessionTracker do
  @moduledoc """
  Visibility v3.3 active-session helper.

  Keeps conflict detection out of the LiveView adapter and makes the
  "active sessions + touched file overlap" rule testable.
  """

  alias TeamJay.Dashboard.ProjectVisibility

  def active_sessions do
    ProjectVisibility.snapshot().active_sessions
  end

  def upsert_session!(session), do: ProjectVisibility.upsert_session!(session)

  def count_conflicts(sessions) when is_list(sessions) do
    sessions
    |> conflict_files()
    |> length()
  end

  def count_conflicts(_), do: 0

  def conflict_files(sessions) when is_list(sessions) do
    sessions
    |> Enum.flat_map(&session_files/1)
    |> Enum.frequencies()
    |> Enum.filter(fn {_file, count} -> count > 1 end)
    |> Enum.map(fn {file, count} -> %{file: file, active_sessions: count} end)
    |> Enum.sort_by(& &1.file)
  end

  def conflict_files(_), do: []

  defp session_files(%{files_touched: files}) when is_list(files), do: files
  defp session_files(%{"files_touched" => files}) when is_list(files), do: files
  defp session_files(_), do: []
end
