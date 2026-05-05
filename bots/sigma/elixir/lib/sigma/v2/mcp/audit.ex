defmodule Sigma.V2.MCP.Audit do
  @moduledoc """
  Best-effort MCP usage audit for Sigma observation reports.

  The audit path must never block tool calls. It records only endpoint/tool/status
  metadata and deliberately excludes request payloads and bearer tokens.
  """

  require Logger

  @table_ready_key {__MODULE__, :table_ready}

  @spec log_request(String.t(), String.t() | nil, integer(), boolean(), map()) :: :ok
  def log_request(endpoint, tool_name, status, success, metadata \\ %{}) do
    if System.get_env("SIGMA_MCP_USAGE_AUDIT_ENABLED", "true") == "false" do
      :ok
    else
      do_log_request(endpoint, tool_name, status, success, metadata)
    end
  end

  defp do_log_request(endpoint, tool_name, status, success, metadata) do
    with :ok <- ensure_table() do
      sql = """
      INSERT INTO sigma_mcp_usage_audit
        (endpoint, tool_name, status, success, metadata, request_at, inserted_at, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW(), NOW())
      """

      case Jay.Core.Repo.query(sql, [
             endpoint,
             tool_name,
             status,
             success,
             Jason.encode!(safe_metadata(metadata))
           ]) do
        {:ok, _} ->
          :ok

        {:error, reason} ->
          Logger.warning("[Sigma.V2.MCP.Audit] insert failed: #{inspect(reason)}")
          :ok
      end
    end
  rescue
    error ->
      Logger.warning("[Sigma.V2.MCP.Audit] exception: #{inspect(error)}")
      :ok
  end

  defp ensure_table do
    case :persistent_term.get(@table_ready_key, false) do
      true ->
        :ok

      _ ->
        create_table()
    end
  end

  defp create_table do
    ddl = [
      """
      CREATE TABLE IF NOT EXISTS sigma_mcp_usage_audit (
        id BIGSERIAL PRIMARY KEY,
        endpoint TEXT NOT NULL,
        tool_name TEXT,
        status INTEGER NOT NULL,
        success BOOLEAN NOT NULL DEFAULT false,
        metadata JSONB NOT NULL DEFAULT '{}',
        request_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      """,
      """
      CREATE INDEX IF NOT EXISTS idx_sigma_mcp_usage_request_at
        ON sigma_mcp_usage_audit (request_at DESC)
      """,
      """
      CREATE INDEX IF NOT EXISTS idx_sigma_mcp_usage_tool
        ON sigma_mcp_usage_audit (tool_name, request_at DESC)
      """
    ]

    Enum.each(ddl, fn sql ->
      case Jay.Core.Repo.query(sql, []) do
        {:ok, _} -> :ok
        {:error, reason} -> raise "sigma_mcp_usage_audit DDL failed: #{inspect(reason)}"
      end
    end)

    :persistent_term.put(@table_ready_key, true)
    :ok
  rescue
    error ->
      Logger.warning("[Sigma.V2.MCP.Audit] ensure table failed: #{inspect(error)}")
      :ok
  end

  defp safe_metadata(metadata) when is_map(metadata) do
    metadata
    |> Map.drop([:authorization, :token, :bearer, "authorization", "token", "bearer"])
  end

  defp safe_metadata(_), do: %{}
end
