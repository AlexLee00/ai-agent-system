defmodule TeamJay.Investment.MarketModeSelector do
  @moduledoc """
  Phase 5-E 시장 상황 -> 매매 모드 자동 선택 스캐폴드.

  reflection / loop_cycle 이벤트를 받아 장기/단기 운용 모드를 고정한다.
  """

  use GenServer

  alias Ecto.Adapters.SQL
  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics
  alias TeamJay.Repo

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_market_mode_selector, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)

    Enum.each(
      [Topics.reflections(symbol), Topics.loop_cycles(symbol)],
      fn topic -> {:ok, _} = PubSub.subscribe(topic) end
    )

    {:ok,
     %{
       symbol: symbol,
       last_reflection: nil,
       last_loop_cycle: nil,
       selection_count: 0,
       last_mode: :swing,
       last_horizon: :mid_term,
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
       last_mode: state.last_mode,
       last_horizon: state.last_horizon,
       last_selected_at: state.last_selected_at,
       persisted_count: state.persisted_count,
       last_persist_status: state.last_persist_status,
       last_persisted_at: state.last_persisted_at
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:reflection, reflection}}, state) do
    {:noreply, maybe_select(%{state | last_reflection: reflection})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:loop_cycle, cycle}}, state) do
    {:noreply, maybe_select(%{state | last_loop_cycle: cycle})}
  end

  defp maybe_select(%{last_reflection: nil} = state), do: state
  defp maybe_select(%{last_loop_cycle: nil} = state), do: state

  defp maybe_select(state) do
    {mode, horizon, rationale} = decide_mode(state.last_reflection, state.last_loop_cycle)

    selection =
      Events.market_mode(state.symbol,
        mode: mode,
        horizon: horizon,
        rationale: rationale,
        reflection: state.last_reflection,
        loop_cycle: state.last_loop_cycle
      )

    persistence = persist_selection(state.symbol, selection)

    PubSub.broadcast_market_mode(state.symbol, {:market_mode, selection})

    %{
      state
      | selection_count: state.selection_count + 1,
        last_mode: mode,
        last_horizon: horizon,
        last_selected_at: selection.selected_at,
        persisted_count: state.persisted_count + persistence.inserted_count,
        last_persist_status: persistence.status,
        last_persisted_at: persistence.persisted_at || state.last_persisted_at
    }
  end

  defp decide_mode(%{recommended_strategy: :scale_allow_pattern}, %{mode: :mode3_manage}) do
    {:position_trade, :short_term, :volatile_manage_mode}
  end

  defp decide_mode(%{recommended_strategy: :wait_master_review}, _cycle) do
    {:defensive, :mid_term, :approval_boundary}
  end

  defp decide_mode(%{recommended_strategy: :hold}, %{mode: :mode1_explore}) do
    {:swing, :long_term, :trend_follow}
  end

  defp decide_mode(_reflection, _cycle) do
    {:scalp, :short_term, :reactive_loop}
  end

  defp persist_selection(symbol, selection) do
    _ = ensure_table()

    params = [
      symbol,
      to_string(selection.mode),
      to_string(selection.horizon),
      to_string(selection.rationale),
      Jason.encode!(json_ready(Map.get(selection, :reflection, %{}))),
      Jason.encode!(json_ready(Map.get(selection, :loop_cycle, %{}))),
      selection.selected_at
    ]

    case SQL.query(
           Repo,
           """
           INSERT INTO investment.market_modes (
             symbol,
             mode,
             horizon,
             rationale,
             reflection,
             loop_cycle,
             selected_at
           )
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
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
             CREATE TABLE IF NOT EXISTS investment.market_modes (
               id BIGSERIAL PRIMARY KEY,
               symbol TEXT NOT NULL,
               mode TEXT NOT NULL,
               horizon TEXT NOT NULL,
               rationale TEXT NOT NULL,
               reflection JSONB NOT NULL DEFAULT '{}'::jsonb,
               loop_cycle JSONB NOT NULL DEFAULT '{}'::jsonb,
               selected_at TIMESTAMPTZ NOT NULL,
               inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
             )
             """,
             []
           ),
         {:ok, _} <-
           SQL.query(
             Repo,
             "CREATE INDEX IF NOT EXISTS market_modes_symbol_selected_at_idx ON investment.market_modes (symbol, selected_at DESC)",
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
