defmodule Sigma.V2.Supervisor do
  @moduledoc """
  Sigma V2 OTP Supervisor — v2 에이전트 트리 관리.
  SIGMA_V2_ENABLED=true 시에만 자식 프로세스 기동.

  Phase 1: Memory.L1 활성화
  Phase 5: MCP Server + HTTP(Bandit) 추가
             - SIGMA_MCP_SERVER_ENABLED=true 시 HTTP 서버 기동 (포트 4000)
  """

  use Supervisor

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(_opts) do
    if System.get_env("SIGMA_V2_ENABLED") == "true" do
      children =
        [Sigma.V2.Memory.L1] ++
          maybe_http_children()

      Supervisor.init(children, strategy: :one_for_one)
    else
      Supervisor.init([], strategy: :one_for_one)
    end
  end

  defp maybe_http_children do
    if System.get_env("SIGMA_MCP_SERVER_ENABLED") == "true" do
      port = String.to_integer(System.get_env("SIGMA_HTTP_PORT", "4000"))

      [
        {Bandit, plug: Sigma.V2.HTTP.Router, port: port, scheme: :http}
      ]
    else
      []
    end
  end
end
