defmodule Luna.V2.Skill.ExecutionDispatcher do
  @moduledoc """
  승인된 주문을 Hephaestos(Binance) 또는 Hanul(KIS)로 전달.

  - crypto → Hephaestos (Hub /hub/investment/execute/crypto)
  - domestic/overseas → Hanul (Hub /hub/investment/execute/kis)
  """
  use Jido.Action,
    name:        "execution_dispatcher",
    description: "주문 실행 디스패처 (Hephaestos/Hanul 라우팅)",
    schema: [
      orders: [type: {:list, :map}, required: true],
      market: [type: :atom, required: true]
    ]

  require Logger

  @impl true
  def run(%{orders: orders, market: market}, _context) do
    results =
      orders
      |> Enum.map(fn order ->
        case dispatch(order, market) do
          {:ok, result} ->
            Logger.info("[ExecDispatcher] 실행 성공 #{order[:symbol]}")
            Map.merge(order, %{execution: result, status: :dispatched})
          {:error, reason} ->
            Logger.error("[ExecDispatcher] 실행 실패 #{order[:symbol]}: #{inspect(reason)}")
            Map.merge(order, %{execution: nil, status: :failed, error: reason})
        end
      end)

    executed = Enum.filter(results, &(&1[:status] == :dispatched))
    failed   = Enum.filter(results, &(&1[:status] == :failed))

    Logger.info("[ExecDispatcher] 실행 완료: 성공=#{length(executed)}, 실패=#{length(failed)}")
    {:ok, %{executed: executed, failed: failed, market: market}}
  end

  defp dispatch(%{market: :crypto} = order, _market) do
    call_hub_execute("crypto", order)
  end
  defp dispatch(%{market: market} = order, _) when market in [:domestic, :overseas] do
    call_hub_execute("kis", order)
  end
  defp dispatch(order, market) do
    call_hub_execute(to_string(market), order)
  end

  defp call_hub_execute(route, order) do
    hub_url = System.get_env("HUB_BASE_URL", "http://localhost:7788")
    hub_token = System.get_env("HUB_AUTH_TOKEN", "")

    payload = %{
      symbol:     order[:symbol],
      direction:  to_string(order[:direction] || :long),
      amount_krw: order[:amount_krw],
      budget_lane: to_string(order[:budget_lane] || :normal),
      rationale:  order[:rationale],
      source:     "luna.v2.commander"
    }

    case Req.post("#{hub_url}/hub/investment/execute/#{route}",
           json: payload,
           headers: [{"Authorization", "Bearer #{hub_token}"}],
           receive_timeout: 30_000) do
      {:ok, %Req.Response{status: 200, body: body}} ->
        {:ok, body}
      {:ok, %Req.Response{status: status, body: body}} ->
        {:error, "HTTP #{status}: #{inspect(body)}"}
      {:error, err} ->
        {:error, inspect(err)}
    end
  end
end
