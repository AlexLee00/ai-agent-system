defmodule TeamJay.Jay.CommandEnvelope do
  @moduledoc """
  제이팀 cross-team 자동화용 typed command envelope.

  기존 알람 중심 연결을 유지하면서도, machine-readable command metadata를
  EventLake에 남겨 추적/재시도/감사를 쉽게 만든다.
  """

  @version 1

  def build(action_type, source_team, target_team, payload, opts \\ []) do
    %{
      version: @version,
      command_id: build_command_id(action_type, source_team, target_team),
      action_type: normalize_atom(action_type),
      source_team: normalize_atom(source_team),
      target_team: normalize_atom(target_team),
      requested_by: to_string(Keyword.get(opts, :requested_by, "jay.cross_team_router")),
      priority: to_string(Keyword.get(opts, :priority, "normal")),
      schema_version: @version,
      created_at: DateTime.utc_now(),
      payload: normalize_payload(payload)
    }
  end

  def summary(%{action_type: action_type, source_team: source_team, target_team: target_team}) do
    "#{source_team} → #{target_team} / #{action_type}"
  end

  def summary(_), do: "cross-team command"

  defp build_command_id(action_type, source_team, target_team) do
    millis = System.system_time(:millisecond)
    "#{normalize_atom(source_team)}-#{normalize_atom(target_team)}-#{normalize_atom(action_type)}-#{millis}"
  end

  defp normalize_payload(payload) when is_map(payload), do: payload
  defp normalize_payload(payload), do: %{value: payload}

  defp normalize_atom(value) when is_atom(value), do: Atom.to_string(value)
  defp normalize_atom(value), do: to_string(value)
end
