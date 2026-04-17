defmodule TeamJay.Investment.StrategyProfileManager do
  @moduledoc """
  Phase 5-E 전략별 파라미터 세트 관리 스캐폴드.

  market_mode를 받아 balanced/aggressive/defensive profile과 parameter set을 선택한다.
  """

  use GenServer

  alias Ecto.Adapters.SQL
  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics
  alias Jay.Core.Repo

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_strategy_profile_manager, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    {:ok, _} = PubSub.subscribe(Topics.market_modes(symbol))

    {:ok,
     %{
       symbol: symbol,
       selection_count: 0,
       last_profile: :balanced,
       last_trade_style: :hold,
       last_selected_at: nil,
       persisted_count: 0,
       last_persist_status: :idle,
       last_persisted_at: nil
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       selection_count: state.selection_count,
       last_profile: state.last_profile,
       last_trade_style: state.last_trade_style,
       last_selected_at: state.last_selected_at,
       persisted_count: state.persisted_count,
       last_persist_status: state.last_persist_status,
       last_persisted_at: state.last_persisted_at
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:market_mode, mode}}, state) do
    {profile, trade_style, parameter_set} = select_profile(mode)

    selection =
      Events.strategy_profile(state.symbol,
        profile: profile,
        trade_style: trade_style,
        parameter_set: parameter_set,
        market_mode: mode
      )

    persistence = persist_selection(state.symbol, selection)

    PubSub.broadcast_strategy_profile(state.symbol, {:strategy_profile, selection})

    {:noreply,
     %{
       state
       | selection_count: state.selection_count + 1,
         last_profile: profile,
         last_trade_style: trade_style,
         last_selected_at: selection.selected_at,
         persisted_count: state.persisted_count + persistence.inserted_count,
         last_persist_status: persistence.status,
         last_persisted_at: persistence.persisted_at || state.last_persisted_at
     }}
  end

  defp select_profile(%{mode: :position_trade}) do
    {:aggressive, :short_term,
     %{max_position_pct: 0.15, risk_per_trade: 0.03, max_concurrent_positions: 4}}
  end

  defp select_profile(%{mode: :defensive}) do
    {:defensive, :capital_preserve,
     %{max_position_pct: 0.08, risk_per_trade: 0.01, max_concurrent_positions: 2}}
  end

  defp select_profile(%{mode: :swing}) do
    {:balanced, :long_term,
     %{max_position_pct: 0.12, risk_per_trade: 0.02, max_concurrent_positions: 3}}
  end

  defp select_profile(_mode) do
    {:aggressive, :short_term,
     %{max_position_pct: 0.1, risk_per_trade: 0.02, max_concurrent_positions: 3}}
  end

  defp persist_selection(symbol, selection) do
    _ = ensure_table()

    params = [
      symbol,
      to_string(selection.profile),
      to_string(selection.trade_style),
      Jason.encode!(json_ready(selection.parameter_set)),
      Jason.encode!(json_ready(Map.get(selection, :market_mode, %{}))),
      selection.selected_at
    ]

    case SQL.query(
           Repo,
           """
           INSERT INTO investment.strategy_profiles (
             symbol,
             profile,
             trade_style,
             parameter_set,
             market_mode,
             selected_at
           )
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
           """,
           params
         ) do
      {:ok, _} -> %{status: :persisted, inserted_count: 1, persisted_at: selection.selected_at}
      {:error, _} -> %{status: :persist_error, inserted_count: 0, persisted_at: nil}
    end
  end

  defp ensure_table do
    with {:ok, _} <-
           SQL.query(
             Repo,
             """
             CREATE TABLE IF NOT EXISTS investment.strategy_profiles (
               id BIGSERIAL PRIMARY KEY,
               symbol TEXT NOT NULL,
               profile TEXT NOT NULL,
               trade_style TEXT NOT NULL,
               parameter_set JSONB NOT NULL DEFAULT '{}'::jsonb,
               market_mode JSONB NOT NULL DEFAULT '{}'::jsonb,
               selected_at TIMESTAMPTZ NOT NULL,
               inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
             )
             """,
             []
           ),
         {:ok, _} <-
           SQL.query(
             Repo,
             "CREATE INDEX IF NOT EXISTS strategy_profiles_symbol_selected_at_idx ON investment.strategy_profiles (symbol, selected_at DESC)",
             []
           ) do
      :ok
    else
      _ -> :error
    end
  end

  defp json_ready(%DateTime{} = value), do: DateTime.to_iso8601(value)
  defp json_ready(%NaiveDateTime{} = value), do: NaiveDateTime.to_iso8601(value)
  defp json_ready(%Date{} = value), do: Date.to_iso8601(value)
  defp json_ready(%Time{} = value), do: Time.to_iso8601(value)
  defp json_ready(%_{} = struct), do: struct |> Map.from_struct() |> json_ready()
  defp json_ready(map) when is_map(map), do: Map.new(map, fn {k, v} -> {json_key(k), json_ready(v)} end)
  defp json_ready(list) when is_list(list), do: Enum.map(list, &json_ready/1)
  defp json_ready(tuple) when is_tuple(tuple), do: tuple |> Tuple.to_list() |> Enum.map(&json_ready/1)
  defp json_ready(atom) when is_atom(atom), do: Atom.to_string(atom)
  defp json_ready(pid) when is_pid(pid), do: inspect(pid)
  defp json_ready(reference) when is_reference(reference), do: inspect(reference)
  defp json_ready(function) when is_function(function), do: inspect(function)
  defp json_ready(value), do: value

  defp json_key(key) when is_atom(key), do: Atom.to_string(key)
  defp json_key(key), do: key
end
