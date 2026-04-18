defmodule Darwin.Repo.Migrations.CreateDarwinSelfRewardingTables do
  use Ecto.Migration

  def change do
    # 사이클 결과 이력 — SelfRewarding 평가 대상 저장소
    create table(:darwin_cycle_history) do
      add :cycle_id,               :string,   size: 100, null: false
      add :paper_title,            :text
      add :stage,                  :string,   size: 50
      add :metrics,                :map                           # JSONB — 성공 지표 전체
      add :duration_sec,           :integer,  default: 0
      add :llm_cost_usd,           :decimal,  precision: 10, scale: 4, default: 0
      add :evaluation_score,       :decimal,  precision: 4,  scale: 2, default: 5.0
      add :implementation_success, :boolean,  default: false
      add :verification_success,   :boolean,  default: false
      add :applied,                :boolean,  default: false
      add :principle_violations,   :integer,  default: 0
      timestamps(updated_at: false)
    end

    create unique_index(:darwin_cycle_history, [:cycle_id])
    create index(:darwin_cycle_history, [:inserted_at])
    create index(:darwin_cycle_history, [:stage])

    # DPO 선호 쌍 — LLM-as-a-Judge 평가 결과
    create table(:darwin_dpo_preference_pairs) do
      add :cycle_id,    :string, size: 100, null: false
      add :paper_title, :text
      add :stage,       :string, size: 50
      add :metrics,     :map                                      # JSONB — 원본 metrics 스냅샷
      add :score,       :decimal, precision: 3, scale: 2, null: false
      add :critique,    :text
      add :improvements, :map, default: %{}                      # JSONB — 개선 제안 배열
      add :category,    :string, size: 20, null: false           # preferred | rejected | neutral
      timestamps(updated_at: false)
    end

    create index(:darwin_dpo_preference_pairs, [:cycle_id])
    create index(:darwin_dpo_preference_pairs, [:category])
    create index(:darwin_dpo_preference_pairs, [:inserted_at])
    create index(:darwin_dpo_preference_pairs, [:stage, :category])

    # Recommender affinity 변경 이력 — 월간 재조정 기록
    create table(:darwin_recommender_history) do
      add :agent_name,        :string,  size: 100, null: false
      add :llm_model,         :string,  size: 100
      add :previous_affinity, :decimal, precision: 3, scale: 2
      add :new_affinity,      :decimal, precision: 3, scale: 2
      add :reason,            :text
      add :preferred_ratio,   :decimal, precision: 3, scale: 2
      add :sample_size,       :integer
      add :changed_by,        :string,  size: 50, default: "auto"
      timestamps(updated_at: false)
    end

    create index(:darwin_recommender_history, [:agent_name])
    create index(:darwin_recommender_history, [:inserted_at])
  end
end
