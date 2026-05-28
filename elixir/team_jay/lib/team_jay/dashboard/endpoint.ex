defmodule TeamJay.Dashboard.Endpoint do
  use Phoenix.Endpoint, otp_app: :team_jay

  @session_options [
    store: :cookie,
    key: "_team_jay_dashboard",
    signing_salt: "tvdashboard",
    same_site: "Lax"
  ]

  socket "/live", Phoenix.LiveView.Socket,
    websocket: [connect_info: [session: @session_options]]

  # Phoenix/LiveView 빌드 JS를 deps에서 직접 서빙
  plug Plug.Static,
    at: "/assets",
    from: {:phoenix, "priv/static"},
    gzip: false,
    only: ~w(phoenix.js)

  plug Plug.Static,
    at: "/assets",
    from: {:phoenix_live_view, "priv/static"},
    gzip: false,
    only: ~w(phoenix_live_view.js)

  plug Plug.Static,
    at: "/assets",
    from: :team_jay,
    gzip: false,
    only: ~w(dashboard.css app.js)

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug Plug.MethodOverride
  plug Plug.Head
  plug Plug.Session, @session_options
  plug TeamJay.Dashboard.Router
end
