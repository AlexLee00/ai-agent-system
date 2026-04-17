defmodule Sigma.V2.Principle.Loader do
  @moduledoc """
  Constitutional 원칙 로더 — sigma_principles.yaml 파싱 + 자기평가.
  Commander가 Directive 실행 전 self_critique/2 호출.
  """

  @principles_path Path.join(
    :code.priv_dir(:team_jay) |> to_string(),
    "../config/sigma_principles.yaml"
  )

  @doc "sigma_principles.yaml 로드 + 파싱."
  @spec load() :: {:ok, map()} | {:error, term()}
  def load do
    path = @principles_path

    if File.exists?(path) do
      case YamlElixir.read_from_file(path) do
        {:ok, parsed} -> {:ok, parsed}
        {:error, reason} -> {:error, "yaml parse error: #{inspect(reason)}"}
      end
    else
      {:error, "principles file not found: #{path}"}
    end
  end

  @doc """
  Directive 실행 전 자기평가.
  P-001~P-031 원칙과 대조하여 승인/차단 여부 반환.
  """
  @spec self_critique(map(), map() | nil) ::
          {:approved, []} | {:blocked, [String.t()]}
  def self_critique(directive, principles \\ nil) do
    resolved_principles =
      case principles do
        nil ->
          case load() do
            {:ok, p} -> p
            _ -> %{}
          end

        p ->
          p
      end

    blocked = check_absolute_prohibitions(directive, resolved_principles)

    if blocked == [], do: {:approved, []}, else: {:blocked, blocked}
  end

  # -------------------------------------------------------------------
  # Private
  # -------------------------------------------------------------------

  defp check_absolute_prohibitions(directive, principles) do
    tiers = principles["tiers"] || principles[:tiers] || []
    tier3 = Enum.find(tiers, &((&1["tier"] || &1[:tier]) == 3)) || %{}
    prohibitions = tier3["prohibitions"] || tier3[:prohibitions] || []

    action = directive[:action] || directive["action"] || ""
    team = directive[:team] || directive["team"] || ""

    prohibitions
    |> Enum.filter(fn rule ->
      rule_action = rule["action"] || rule[:action] || ""
      rule_team = rule["team"] || rule[:team] || ""

      matches_action?(action, rule_action) and
        (rule_team == "" or rule_team == team or rule_team == "*")
    end)
    |> Enum.map(fn rule ->
      principle = rule["principle"] || rule[:principle] || "unknown"
      description = rule["description"] || rule[:description] || ""
      "#{principle}: #{description}"
    end)
  end

  defp matches_action?(_action, ""), do: false
  defp matches_action?(action, rule_action), do: String.contains?(action, rule_action)
end
