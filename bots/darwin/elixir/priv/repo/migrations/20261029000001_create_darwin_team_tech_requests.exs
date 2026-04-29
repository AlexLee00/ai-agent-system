defmodule Darwin.Repo.Migrations.CreateDarwinTeamTechRequests do
  use Ecto.Migration

  def change do
    create table(:darwin_team_tech_requests) do
      add :requesting_team, :string, size: 50, null: false
      add :requesting_agent, :string, size: 80
      add :request_type, :string, size: 50
      add :description, :text, null: false
      add :priority, :integer, default: 5
      add :status, :string, size: 20, null: false, default: "queued"
      add :matched_papers, {:array, :bigint}, default: []
      add :resolved_at, :utc_datetime
      timestamps(updated_at: false)
    end

    create index(:darwin_team_tech_requests, [:requesting_team])
    create index(:darwin_team_tech_requests, [:status])
    create index(:darwin_team_tech_requests, [:priority])
    create index(:darwin_team_tech_requests, [:inserted_at])
  end
end
