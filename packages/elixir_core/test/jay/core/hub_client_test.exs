defmodule Jay.Core.HubClientTest do
  use ExUnit.Case, async: true

  test "alarm HTTP responses preserve delivery success and failure semantics" do
    assert {:ok, %{"accepted" => true}} =
             Jay.Core.HubClient.normalize_alarm_response(
               {:ok, %{status: 200, body: %{"accepted" => true}}}
             )

    assert {:error, reason} =
             Jay.Core.HubClient.normalize_alarm_response(
               {:ok, %{status: 503, body: %{"error" => "unavailable"}}}
             )

    assert reason =~ "HTTP 503"
    assert {:error, :closed} = Jay.Core.HubClient.normalize_alarm_response({:error, :closed})
  end
end
