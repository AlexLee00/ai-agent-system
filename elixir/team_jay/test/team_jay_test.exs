defmodule TeamJayTest do
  use ExUnit.Case
  alias TeamJay.Agents.Andy
  alias TeamJay.Schemas.EventLake
  import TeamJay.ChangesetHelpers

  test "event lake changeset requires event_type" do
    changeset = EventLake.changeset(%EventLake{}, %{})
    refute changeset.valid?
    assert "can't be blank" in errors_on(changeset).event_type
  end

  test "andy state shape is readable" do
    status = Andy.get_status()
    assert status.name == "andy"
    assert status.team == "ska"
    assert is_integer(status.check_count)
  end
end
