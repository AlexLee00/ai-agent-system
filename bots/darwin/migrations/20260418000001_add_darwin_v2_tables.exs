defmodule TeamJay.Repo.Migrations.AddDarwinV2Tables do
  use Ecto.Migration

  def change do
    # 자율 레벨 이력
    create table(:darwin_autonomy_level) do
      add :level, :string, null: false, default: "L3"
      add :reason, :string
      add :consecutive_successes, :integer, default: 0
      add :apply_count, :integer, default: 0
      add :error_count, :integer, default: 0
      add :last_error, :text
      add :level_since, :utc_datetime_usec
      timestamps()
    end

    create index(:darwin_autonomy_level, [:level, :inserted_at])

    # 사이클 결과 기록
    create table(:darwin_cycle_results) do
      add :paper_title, :string
      add :relevance_score, :integer
      add :verification_status, :string
      add :proposal_id, :string
      add :analyst_name, :string
      add :effectiveness, :float
      add :completed_at, :utc_datetime_usec
      timestamps()
    end

    create index(:darwin_cycle_results, [:analyst_name, :completed_at])
    create index(:darwin_cycle_results, [:verification_status, :completed_at])

    # 분석가 프롬프트 세대 (ESPL)
    create table(:darwin_analyst_prompts) do
      add :name, :string, null: false
      add :prompt_text, :text, null: false
      add :generation, :integer, default: 0
      add :fitness, :float, default: 0.0
      add :active, :boolean, default: false
      timestamps()
    end

    create unique_index(:darwin_analyst_prompts, [:name])
    create index(:darwin_analyst_prompts, [:active, :generation])
  end
end
