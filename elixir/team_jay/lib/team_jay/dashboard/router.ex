defmodule TeamJay.Dashboard.Router do
  use Phoenix.Router, helpers: false
  import Phoenix.LiveView.Router

  pipeline :browser do
    plug(:accepts, ["html"])
    plug(:fetch_session)
    plug(:fetch_live_flash)
    plug(:put_root_layout, html: {TeamJay.Dashboard.Layouts, :root})
    plug(:protect_from_forgery)
    plug(:put_secure_browser_headers)
  end

  pipeline :api do
    plug(:accepts, ["json"])
  end

  scope "/" do
    forward("/healthz", TeamJay.Dashboard.HealthPlug)
  end

  scope "/api" do
    pipe_through(:api)

    post("/master-intervention", TeamJay.Dashboard.MasterInterventionController, :create)
  end

  scope "/" do
    pipe_through(:browser)
    live("/", TeamJay.Dashboard.Live.DashboardLive, :index)
  end
end
