defmodule Sigma.V2.MCP.Auth do
  @moduledoc """
  Bearer Token 인증 Plug — Hub의 기존 패턴 재사용.
  SIGMA_MCP_TOKEN 환경변수로 검증.
  """

  import Plug.Conn

  def init(opts), do: opts

  def call(conn, _opts) do
    with ["Bearer " <> token] <- get_req_header(conn, "authorization"),
         true <- valid_token?(token) do
      conn
    else
      _ ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(401, Jason.encode!(%{error: "unauthorized"}))
        |> halt()
    end
  end

  defp valid_token?(token) do
    expected = System.get_env("SIGMA_MCP_TOKEN")
    is_binary(expected) and byte_size(expected) > 0 and token == expected
  end
end
