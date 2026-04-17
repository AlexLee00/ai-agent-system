defmodule Darwin.V2.MCP.Auth do
  @moduledoc """
  Darwin V2 MCP Bearer Token 인증.

  토큰: DARWIN_MCP_AUTH_TOKEN 환경변수.
  Plug.Conn 인터페이스로 동작하며, 인증 실패 시 401 반환.

  generate_token/0 는 테스트 전용 (운영 환경에서 사용 금지).
  """

  import Plug.Conn
  require Logger

  @log_prefix "[다윈V2 MCP서버]"

  def init(opts), do: opts

  @doc """
  Plug 미들웨어로 사용 시 Bearer 토큰 검증.
  Authorization: Bearer <token> 헤더 필요.
  """
  def call(conn, _opts) do
    with ["Bearer " <> token] <- get_req_header(conn, "authorization"),
         true <- valid_token?(token) do
      conn
    else
      _ ->
        Logger.warning("#{@log_prefix} 인증 실패 — 유효하지 않은 토큰")
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(401, Jason.encode!(%{error: "unauthorized", message: "유효한 Bearer 토큰이 필요합니다"}))
        |> halt()
    end
  end

  @doc """
  토큰 직접 검증 (라우터에서 inline 사용 시).
  """
  @spec validate_token(String.t()) :: :ok | {:error, :invalid_token}
  def validate_token(token) when is_binary(token) do
    if valid_token?(token), do: :ok, else: {:error, :invalid_token}
  end
  def validate_token(_), do: {:error, :invalid_token}

  @doc """
  테스트용 임시 토큰 생성. 운영 환경에서 사용 금지.
  """
  @spec generate_token() :: String.t()
  def generate_token do
    :crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)
  end

  # Private

  defp valid_token?(token) do
    expected = System.get_env("DARWIN_MCP_AUTH_TOKEN")
    is_binary(expected) and byte_size(expected) > 0 and
      Plug.Crypto.secure_compare(expected, token)
  end
end
