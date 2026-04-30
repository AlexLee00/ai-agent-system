defmodule Luna.V2.Agents.Sweeper do
  @moduledoc """
  Shadow-only ledger/wallet parity agent.
  """

  def compare(ledger \\ %{}, wallet \\ %{}) do
    ledger_qty = Map.get(ledger, :quantity, Map.get(ledger, "quantity", 0.0))
    wallet_qty = Map.get(wallet, :quantity, Map.get(wallet, "quantity", 0.0))
    delta = wallet_qty - ledger_qty

    %{
      agent: "sweeper",
      shadow: true,
      delta: delta,
      state: if(abs(delta) <= 1.0e-8, do: :in_sync, else: :drift_detected)
    }
  end
end
