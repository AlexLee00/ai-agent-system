defmodule TeamJay.Repo.Migrations.AddDarwinV2LlmRoutingLog do
  use Ecto.Migration

  def change do
    create table(:darwin_llm_routing_log) do
      add :agent, :string
      add :primary_route, :string
      add :actual_route, :string
      add :success, :boolean, default: false
      add :error_reason, :string
      add :logged_at, :utc_datetime_usec
      timestamps()
    end

    create index(:darwin_llm_routing_log, [:agent, :logged_at])
    create index(:darwin_llm_routing_log, [:success, :logged_at])
  end
end
