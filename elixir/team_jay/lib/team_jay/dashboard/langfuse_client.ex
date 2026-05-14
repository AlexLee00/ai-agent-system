defmodule TeamJay.Dashboard.LangfuseClient do
  require Logger

  @recv_timeout 10_000

  # GET /api/public/traces/:trace_id
  def get_trace(trace_id) when is_binary(trace_id) do
    with {:ok, cfg} <- build_config() do
      url = "#{cfg.host}/api/public/traces/#{URI.encode_www_form(trace_id)}"
      do_get(url, cfg.auth_header)
    end
  end

  # GET /api/public/traces — 최근 목록 (debug용)
  def list_traces(limit \\ 10) do
    with {:ok, cfg} <- build_config() do
      url = "#{cfg.host}/api/public/traces?limit=#{limit}&page=1"
      do_get(url, cfg.auth_header)
    end
  end

  defp do_get(url, auth_header) do
    case Req.get(url,
           headers: [{"authorization", auth_header}],
           receive_timeout: @recv_timeout
         ) do
      {:ok, %{status: 200, body: body}} ->
        {:ok, body}

      {:ok, %{status: 404}} ->
        {:error, :not_found}

      {:ok, %{status: status}} ->
        Logger.warning("[LangfuseClient] HTTP #{status} — #{url}")
        {:error, {:http_error, status}}

      {:error, reason} ->
        Logger.warning("[LangfuseClient] 요청 실패: #{inspect(reason)}")
        {:error, reason}
    end
  rescue
    e ->
      Logger.error("[LangfuseClient] exception: #{inspect(e)}")
      {:error, {:exception, e}}
  end

  defp build_config do
    env = Application.get_env(:team_jay, :langfuse, [])
    host = (Keyword.get(env, :host) || System.get_env("LANGFUSE_HOST") || "http://localhost:3000") |> String.trim_trailing("/")
    public_key = System.get_env("LANGFUSE_PUBLIC_KEY", "")
    secret_key = System.get_env("LANGFUSE_SECRET_KEY", "")

    cond do
      public_key == "" -> {:error, :no_public_key}
      secret_key == "" -> {:error, :no_secret_key}
      true -> {:ok, %{host: host, auth_header: "Basic #{Base.encode64("#{public_key}:#{secret_key}")}"}}
    end
  end
end
