defmodule TeamJay.Repo.Migrations.AddDarwinAutonomyPromotion do
  use Ecto.Migration

  def change do
    create table(:darwin_autonomy_promotion_log) do
      add :from_level, :integer, null: false
      add :to_level, :integer, null: false
      add :stats, :map, null: false
      add :approver, :string, size: 50, default: "candidate"
      add :telegram_sent_at, :utc_datetime
      add :approved_at, :utc_datetime
      add :effective_at, :utc_datetime
      timestamps(updated_at: false)
    end

    create index(:darwin_autonomy_promotion_log, [:from_level, :to_level])
    create index(:darwin_autonomy_promotion_log, [:inserted_at])
  end
end
