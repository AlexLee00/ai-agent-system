defmodule Sigma.V2.Config do
  @moduledoc """
  팀별 config 파일 Snapshot/Apply/Restore — Tier 2 자동 적용의 백본.
  sigma_v2_config_snapshots 테이블에 스냅샷 보관.
  참조: bots/sigma/docs/PLAN.md §6 Phase 3
  """

  require Logger

  @allowed_teams ~w(blog luna investment ska claude darwin justin sigma)

  @doc "현재 config를 DB에 스냅샷."
  def snapshot(team) when team in @allowed_teams do
    path = config_path(team)

    case File.read(path) do
      {:ok, content} ->
        snapshot_id = Ecto.UUID.generate()

        case Jay.Core.Repo.query(
               "INSERT INTO sigma_v2_config_snapshots (id, team, content, created_at) VALUES ($1, $2, $3, NOW())",
               [snapshot_id, team, content]
             ) do
          {:ok, _} ->
            {:ok, %{id: snapshot_id, team: team, content: content}}

          {:error, reason} ->
            {:error, {:db_error, reason}}
        end

      {:error, reason} ->
        Logger.warning("[sigma/config] snapshot 실패 — team=#{team} path=#{path}: #{inspect(reason)}")
        {:error, {:file_read_error, reason}}
    end
  rescue
    e -> {:error, e}
  end

  def snapshot(team) do
    Logger.warning("[sigma/config] 허용되지 않은 팀: #{team}")
    {:error, :team_not_allowed}
  end

  @doc "JSON patch(RFC 6902 스타일) 적용 — 스냅샷 후 파일 수정."
  def apply_patch(team, patch) do
    with {:ok, %{id: snapshot_id, content: raw}} <- snapshot(team),
         {:ok, current} <- parse_config(raw),
         patched <- merge_patch(current, patch),
         :ok <- verify_patch_safety(current, patched),
         :ok <- write_config(team, patched) do
      {:ok, %{snapshot_id: snapshot_id, patched: patched}}
    end
  end

  @doc "스냅샷으로 복원."
  def restore(team, snapshot_id) do
    case fetch_snapshot(snapshot_id, team) do
      {:ok, content} ->
        path = config_path(team)

        case File.write(path, content) do
          :ok ->
            Logger.info("[sigma/config] 복원 완료 — team=#{team} snapshot=#{snapshot_id}")
            {:ok, :restored}

          {:error, reason} ->
            {:error, {:file_write_error, reason}}
        end

      {:error, reason} ->
        {:error, reason}
    end
  rescue
    e -> {:error, e}
  end

  # ---

  defp config_path("luna"),       do: Path.join(["bots", "investment", "config.yaml"])
  defp config_path("investment"), do: Path.join(["bots", "investment", "config.yaml"])
  defp config_path("blog"),       do: Path.join(["bots", "blog", "config.yaml"])
  defp config_path("ska"),        do: Path.join(["bots", "ska", "config.yaml"])
  defp config_path("claude"),     do: Path.join(["bots", "claude", "config.json"])
  defp config_path("darwin"),     do: Path.join(["bots", "darwin", "config.yaml"])
  defp config_path(team),         do: Path.join(["bots", team, "config.yaml"])

  defp parse_config(content) do
    case Jason.decode(content) do
      {:ok, map} -> {:ok, map}
      {:error, _} ->
        # YAML fallback
        case YamlElixir.read_from_string(content) do
          {:ok, map} -> {:ok, map}
          _ -> {:ok, %{}}
        end
    end
  end

  defp merge_patch(current, patch) when is_map(patch) do
    Map.merge(current, patch, fn _k, _old, new -> new end)
  end
  defp merge_patch(current, _), do: current

  defp verify_patch_safety(current, patched) do
    # 숫자 필드 ±20% 이내 + 필수 키 유지
    violations =
      Enum.reduce(current, [], fn {k, v}, acc ->
        new_v = Map.get(patched, k, v)

        cond do
          is_number(v) and v != 0 and abs((new_v - v) / v) > 0.20 ->
            [{:range_violation, k, v, new_v} | acc]

          not Map.has_key?(patched, k) ->
            [{:missing_key, k} | acc]

          true ->
            acc
        end
      end)

    if violations == [], do: :ok, else: {:error, {:safety_violation, violations}}
  end

  defp write_config(team, data) do
    path = config_path(team)
    encoded = Jason.encode!(data, pretty: true)
    File.write(path, encoded)
  end

  defp fetch_snapshot(snapshot_id, team) do
    case Jay.Core.Repo.query(
           "SELECT content FROM sigma_v2_config_snapshots WHERE id = $1 AND team = $2 LIMIT 1",
           [snapshot_id, team]
         ) do
      {:ok, %{rows: [[content]]}} -> {:ok, content}
      _ -> {:error, :snapshot_not_found}
    end
  rescue
    _ -> {:error, :snapshot_not_found}
  end
end
