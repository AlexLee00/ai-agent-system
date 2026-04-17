defmodule Darwin.V2.HTTP.Router do
  @moduledoc "다윈 V2 HTTP 라우터 (Bandit/Plug) — Phase 5에서 MCP 엔드포인트 추가 예정."

  use Plug.Router

  plug :match
  plug :dispatch

  get "/darwin/health" do
    status = %{status: "ok", v2: Application.get_env(:darwin, :v2_enabled, false)}
    send_resp(conn, 200, Jason.encode!(status))
  end

  get "/darwin/autonomy" do
    state = Darwin.V2.AutonomyLevel.get()
    send_resp(conn, 200, Jason.encode!(Map.new(state, fn {k, v} -> {to_string(k), inspect(v)} end)))
  end

  match _ do
    send_resp(conn, 404, "Not found")
  end
end
