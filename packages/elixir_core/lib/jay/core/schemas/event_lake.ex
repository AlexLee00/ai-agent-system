defmodule Jay.Core.Schemas.EventLake do
  use Ecto.Schema
  import Ecto.Changeset

  @schema_prefix "agent"

  schema "event_lake" do
    field :event_type, :string
    field :team, :string
    field :bot_name, :string
    field :severity, :string
    field :trace_id, :string
    field :title, :string
    field :message, :string
    field :tags, {:array, :string}
    field :metadata, :map
    field :feedback_score, :float
    field :feedback, :string

    timestamps(type: :utc_datetime, inserted_at: :created_at, updated_at: :updated_at)
  end

  def changeset(event, attrs) do
    event
    |> cast(attrs, [:event_type, :team, :bot_name, :severity, :trace_id, :title, :message, :tags, :metadata, :feedback_score, :feedback])
    |> validate_required([:event_type])
  end
end
