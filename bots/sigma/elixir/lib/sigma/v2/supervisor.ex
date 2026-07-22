defmodule Sigma.V2.Supervisor do
  @moduledoc """
  Sigma V2 OTP Supervisor — v2 에이전트 트리 관리.
  SIGMA_V2_ENABLED=true 시에만 자식 프로세스 기동.

  Phase 1:   Memory.L1 활성화
  Phase 2:   Phoenix.PubSub(Sigma.V2.PubSub) + RollbackScheduler 추가
  Phase 3:   RollbackScheduler 활성화
  Phase 5:   MCP Server + HTTP(Bandit) 추가
  Phase A+N: MapeKLoop GenServer 추가 (SIGMA_MAPEK_ENABLED=true 시 활성)
  """

  use Supervisor

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(opts) do
    if System.get_env("SIGMA_V2_ENABLED") == "true" do
      children =
        [
          {Phoenix.PubSub, name: Sigma.V2.PubSub},
          Sigma.V2.Memory.L1,
          Sigma.V2.RollbackScheduler,
          Sigma.V2.MapeKLoop
        ] ++
          maybe_http_children(opts)

      Supervisor.init(children, strategy: :one_for_one)
    else
      Supervisor.init([], strategy: :one_for_one)
    end
  end

  defp maybe_http_children(opts) do
    port_str = System.get_env("SIGMA_HTTP_PORT")
    port = if port_str, do: String.to_integer(port_str), else: nil

    # SIGMA_HTTP_PORT가 설정되고 포트가 비어있을 때 HTTP 서버 기동.
    # MCP OFF → /sigma/* Shadow 경로만 노출, MCP ON → /mcp/* 추가 활성화.
    cond do
      embedded_http_suppressed?(opts) ->
        []

      port && port_available?(port) ->
        [{Bandit, plug: Sigma.V2.HTTP.Router, port: port, scheme: :http, ip: {127, 0, 0, 1}}]

      true ->
        []
    end
  end

  defp embedded_http_suppressed?(opts) do
    Keyword.get(opts, :suppress_http, false) or
      System.get_env("TEAM_JAY_SUPPRESS_EMBEDDED_HTTP") == "true"
  end

  defp port_available?(port) do
    case :gen_tcp.listen(port, [:binary, {:reuseaddr, true}, {:ip, {127, 0, 0, 1}}]) do
      {:ok, socket} ->
        :gen_tcp.close(socket)
        true

      {:error, _} ->
        false
    end
  end
end
