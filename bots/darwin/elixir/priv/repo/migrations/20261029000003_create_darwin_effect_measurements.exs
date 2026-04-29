defmodule Darwin.Repo.Migrations.CreateDarwinEffectMeasurements do
  use Ecto.Migration

  def change do
    create table(:darwin_effect_measurements) do
      add :paper_id, :string, size: 100, null: false
      add :hypothesis_id, :bigint
      add :interval_label, :string, size: 20, null: false
      add :metric_name, :string, size: 100, null: false
      add :value_before, :decimal, precision: 12, scale: 4
      add :value_after, :decimal, precision: 12, scale: 4
      add :delta, :decimal, precision: 12, scale: 4
      add :delta_pct, :decimal, precision: 8, scale: 4
      add :observed_at, :utc_datetime, null: false
      add :notes, :text
      timestamps(updated_at: false)
    end

    create index(:darwin_effect_measurements, [:paper_id])
    create index(:darwin_effect_measurements, [:hypothesis_id])
    create index(:darwin_effect_measurements, [:interval_label])
    create index(:darwin_effect_measurements, [:observed_at])
  end
end
