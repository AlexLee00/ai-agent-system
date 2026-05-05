defmodule Darwin.Repo.Migrations.CreateDarwinCodebaseTables do
  use Ecto.Migration

  def change do
    create table(:darwin_codebase_reports) do
      add :summary_text, :text, null: false
      add :total_loc, :integer, null: false, default: 0
      add :total_files, :integer, null: false, default: 0
      add :teams_analyzed, {:array, :string}, default: []
      add :refactoring_count, :integer, null: false, default: 0
      timestamps(updated_at: false)
    end

    create index(:darwin_codebase_reports, [:inserted_at])

    create table(:darwin_module_metrics) do
      add :report_id, :bigint, null: false
      add :team, :string, size: 50, null: false
      add :file_path, :text, null: false
      add :loc, :integer, null: false, default: 0
      add :function_count, :integer, null: false, default: 0
      add :complexity, :integer, null: false, default: 0
      timestamps(updated_at: false)
    end

    create index(:darwin_module_metrics, [:report_id])
    create index(:darwin_module_metrics, [:team])
    create index(:darwin_module_metrics, [:loc])
    create unique_index(:darwin_module_metrics, [:report_id, :file_path])
  end
end
