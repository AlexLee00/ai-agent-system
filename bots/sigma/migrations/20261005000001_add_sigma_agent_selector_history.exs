defmodule TeamJay.Repo.Migrations.AddSigmaAgentSelectorHistory do
  use Ecto.Migration

  def change do
    create table(:sigma_agent_selector_history) do
      add :agent_name, :string, null: false
      add :role, :string
      add :team, :string
      add :task_hint, :text
      add :selection_count, :integer, default: 0
      add :success_count, :integer, default: 0
      add :last_selected_at, :utc_datetime_usec
      timestamps(inserted_at: :created_at, updated_at: false)
    end

    create unique_index(:sigma_agent_selector_history, [:agent_name])
    create index(:sigma_agent_selector_history, [:role, :team])
    create index(:sigma_agent_selector_history, [:selection_count])
  end
end
