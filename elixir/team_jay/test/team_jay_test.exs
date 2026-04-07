defmodule TeamJayTest do
  use ExUnit.Case
  alias TeamJay.Agents.PortAgent
  alias TeamJay.EventLake
  alias TeamJay.MarketRegime
  alias TeamJay.Schemas.EventLake, as: EventLakeSchema
  import TeamJay.ChangesetHelpers

  test "event lake changeset requires event_type" do
    changeset = EventLakeSchema.changeset(%EventLakeSchema{}, %{})
    refute changeset.valid?
    assert "can't be blank" in errors_on(changeset).event_type
  end

  test "event lake stats api responds" do
    stats = EventLake.get_stats()
    assert is_map(stats)
    assert Map.has_key?(stats, :total)
    assert Map.has_key?(stats, :by_type)
    assert Map.has_key?(stats, :by_team)
  end

  test "market regime detects bullish trend" do
    result =
      MarketRegime.detect(%{
        aria: %{rsi: 70, trend: "up"},
        sophia: %{sentiment: 0.5}
      })

    assert result.regime == :trending_bull
    assert result.confidence > 0.0
  end

  test "port agent status is readable through registry" do
    status = PortAgent.get_status(:andy)
    assert status.name == :andy
    assert status.status in [:idle, :running]
  end
end
