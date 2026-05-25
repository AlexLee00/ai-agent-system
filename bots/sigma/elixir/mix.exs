defmodule Sigma.MixProject do
  use Mix.Project

  @team_jay_dir Path.expand("../../../elixir/team_jay", __DIR__)
  @sigma_test_files Path.wildcard(Path.join([__DIR__, "test", "sigma", "v2", "**", "*_test.exs"]))
  @safe_test_env %{
    "TEAM_JAY_DASHBOARD_SERVER" => "false",
    "TEAM_JAY_ENABLE_ALARM_DELIVERY" => "false",
    "TEAM_JAY_ENABLE_DIAGNOSTICS" => "false",
    "LLM_HUB_ROUTING_ENABLED" => "false",
    "LLM_HUB_ROUTING_SHADOW" => "false",
    "HUB_ENABLE_CLAUDE_PUBLIC_API" => "false",
    "HUB_ENABLE_ANTHROPIC_PUBLIC_API" => "false",
    "JAY_LLM_DIRECT_FALLBACK" => "false",
    "HUB_LLM_DIRECT_FALLBACK" => "false",
    "SIGMA_LLM_DIRECT_FALLBACK" => "false",
    "SIGMA_V2_ENABLED" => "false",
    "SIGMA_MAPEK_ENABLED" => "false",
    "SIGMA_SELF_REWARDING_ENABLED" => "false",
    "SIGMA_AGENTIC_RAG_ENABLED" => "false",
    "SIGMA_TELEGRAM_ENHANCED" => "false",
    "SIGMA_MCP_SERVER_ENABLED" => "false"
  }

  def project do
    [
      app: :sigma,
      version: "0.1.0",
      elixir: "~> 1.19",
      start_permanent: Mix.env() == :prod,
      deps: [],
      aliases: aliases()
    ]
  end

  def application do
    [extra_applications: [:logger]]
  end

  defp aliases do
    sigma_test_args = Enum.join(@sigma_test_files, " ")
    safe_test_env = Enum.map_join(@safe_test_env, " ", fn {key, value} -> "#{key}=#{value}" end)

    [
      compile: [
        "cmd --cd #{@team_jay_dir} mix compile"
      ],
      test: [
        "cmd --cd #{@team_jay_dir} env #{safe_test_env} mix test --no-start #{sigma_test_args}"
      ],
      shadow: [
        "cmd --cd #{@team_jay_dir} mix run -e 'Sigma.V2.ShadowRunner.run_once() |> IO.inspect'"
      ],
      migrate: [
        "cmd --cd #{@team_jay_dir} mix sigma.migrate"
      ]
    ]
  end
end
