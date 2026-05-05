defmodule TeamJay.Repo.Migrations.SigmaMcpUsageAudit do
  use Ecto.Migration

  def change do
    create_if_not_exists table(:sigma_mcp_usage_audit) do
      add :endpoint, :text, null: false
      add :tool_name, :text
      add :status, :integer, null: false
      add :success, :boolean, null: false, default: false
      add :metadata, :map, null: false, default: %{}
      add :request_at, :utc_datetime_usec, null: false
      timestamps()
    end

    create_if_not_exists index(:sigma_mcp_usage_audit, [:request_at])
    create_if_not_exists index(:sigma_mcp_usage_audit, [:tool_name, :request_at])
  end
end
