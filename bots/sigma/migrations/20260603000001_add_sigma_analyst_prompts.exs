defmodule TeamJay.Repo.Migrations.AddSigmaAnalystPrompts do
  use Ecto.Migration

  def change do
    create table(:sigma_analyst_prompts) do
      add :name, :string, null: false
      add :system_prompt, :text, null: false
      add :generation, :integer, null: false, default: 1
      add :status, :string, null: false, default: "shadow"
      add :fitness_score, :float
      add :parents, :map
      add :promoted_at, :utc_datetime_usec
      timestamps()
    end

    create index(:sigma_analyst_prompts, [:name, :status, :generation])
    create index(:sigma_analyst_prompts, [:status])
  end
end
