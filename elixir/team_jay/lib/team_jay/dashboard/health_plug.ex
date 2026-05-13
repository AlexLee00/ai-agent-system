defmodule TeamJay.Dashboard.HealthPlug do
  @moduledoc false

  import Plug.Conn

  def init(opts), do: opts

  def call(conn, _opts) do
    payload = %{
      ok: true,
      service: "team_jay_dashboard",
      phase: "A",
      checked_at: DateTime.utc_now()
    }

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(payload))
  end
end
