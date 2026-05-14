defmodule TeamJay.DashboardPhaseATest do
  use ExUnit.Case, async: true
  import Plug.Test

  test "health endpoint plug returns phase A readiness payload" do
    conn = conn(:get, "/healthz") |> TeamJay.Dashboard.HealthPlug.call([])

    assert conn.status == 200
    assert {:ok, payload} = Jason.decode(conn.resp_body)
    assert payload["ok"] == true
    assert payload["service"] == "team_jay_dashboard"
    assert payload["phase"] == "A"
  end

  test "dashboard endpoint is wired to Bandit and TeamJay PubSub" do
    config = Application.get_env(:team_jay, TeamJay.Dashboard.Endpoint, [])

    assert Keyword.get(config, :adapter) == Bandit.PhoenixAdapter
    assert Keyword.get(config, :pubsub_server) == TeamJay.PubSub
    assert Application.get_env(:team_jay, :dashboard_pubsub) == TeamJay.PubSub
    assert Application.get_env(:jay_core, :dashboard_pubsub) == TeamJay.PubSub
  end

  test "router exposes root LiveView and health routes" do
    routes = TeamJay.Dashboard.Router.__routes__()

    assert Enum.any?(routes, &(&1.path == "/" and &1.plug == Phoenix.LiveView.Plug))
    assert Enum.any?(routes, &String.starts_with?(&1.path, "/healthz"))
  end

  test "router exposes Phase E master intervention API" do
    routes = TeamJay.Dashboard.Router.__routes__()

    assert Enum.any?(
             routes,
             &(&1.verb == :post and &1.path == "/api/master-intervention" and
                 &1.plug == TeamJay.Dashboard.MasterInterventionController)
           )
  end
end
