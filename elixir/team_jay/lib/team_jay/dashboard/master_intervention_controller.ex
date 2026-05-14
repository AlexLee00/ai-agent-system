defmodule TeamJay.Dashboard.MasterInterventionController do
  @moduledoc """
  Internal API bridge for master interventions.

  The primary producer is Hub's Telegram callback poller. This controller only
  records an intervention event; it does not mutate trading state.
  """
  use Phoenix.Controller, formats: [:json]

  plug(:ensure_authorized)

  def create(conn, params) do
    with {:ok, title} <- required_string(params, "title"),
         subtype <- normalize_subtype(params["subtype"] || params[:subtype]),
         metadata <- normalize_metadata(params["metadata"] || params[:metadata]) do
      payload =
        metadata
        |> Map.merge(%{
          "title" => title,
          "subtype" => subtype,
          "source" => "hub.telegram_callback_poller",
          "received_at" =>
            DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
        })

      Jay.V2.AutonomyController.record_master_intervention(payload)

      json(conn, %{
        ok: true,
        event_type: "master.intervention.#{subtype}",
        title: title,
        accepted_at: payload["received_at"]
      })
    else
      {:error, message} ->
        conn
        |> put_status(:bad_request)
        |> json(%{ok: false, error: message})
    end
  end

  defp ensure_authorized(conn, _opts) do
    expected = intervention_token()

    cond do
      expected == "" and loopback?(conn.remote_ip) ->
        conn

      request_token(conn) == expected ->
        conn

      true ->
        conn
        |> put_status(:unauthorized)
        |> json(%{ok: false, error: "unauthorized"})
        |> halt()
    end
  end

  defp intervention_token do
    [
      System.get_env("TEAM_JAY_MASTER_INTERVENTION_TOKEN"),
      System.get_env("HUB_CONTROL_CALLBACK_SECRET")
    ]
    |> Enum.find_value("", fn
      value when is_binary(value) ->
        value = String.trim(value)
        if value == "", do: nil, else: value

      _ ->
        nil
    end)
  end

  defp request_token(conn) do
    bearer =
      conn
      |> get_req_header("authorization")
      |> List.first()
      |> case do
        "Bearer " <> token -> String.trim(token)
        _ -> ""
      end

    header =
      conn
      |> get_req_header("x-team-jay-master-intervention-token")
      |> List.first()
      |> to_string()
      |> String.trim()

    if bearer != "", do: bearer, else: header
  end

  defp loopback?({127, 0, 0, 1}), do: true
  defp loopback?({0, 0, 0, 0, 0, 0, 0, 1}), do: true
  defp loopback?(_), do: false

  defp required_string(params, key) do
    case params[key] || params[String.to_atom(key)] do
      value when is_binary(value) ->
        value = String.trim(value)
        if value == "", do: {:error, "#{key} required"}, else: {:ok, String.slice(value, 0, 240)}

      _ ->
        {:error, "#{key} required"}
    end
  end

  defp normalize_subtype(value) when value in ["telegram", :telegram], do: "telegram"
  defp normalize_subtype(value) when value in ["phase_change", :phase_change], do: "phase_change"
  defp normalize_subtype(value) when value in ["decision", :decision], do: "decision"
  defp normalize_subtype(_), do: "telegram"

  defp normalize_metadata(value) when is_map(value) do
    Map.new(value, fn {key, metadata_value} -> {to_string(key), metadata_value} end)
  end

  defp normalize_metadata(_), do: %{}
end
