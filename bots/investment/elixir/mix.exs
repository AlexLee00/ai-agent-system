defmodule Luna.MixProject do
  use Mix.Project

  @team_jay_dir Path.expand("../../../elixir/team_jay", __DIR__)
  @luna_test_dir Path.expand("test", __DIR__)

  def project do
    [
      app: :luna,
      version: "2.0.0",
      elixir: "~> 1.19",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: aliases()
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {Luna.Application, []}
    ]
  end

  defp deps do
    [
      {:jido,        "~> 2.2"},
      {:jido_action, "~> 2.2"},
      {:jido_signal, "~> 2.1"},
      {:jido_ai,     "~> 2.1"},
      {:ecto_sql,    "~> 3.12"},
      {:postgrex,    "~> 0.20"},
      {:jason,       "~> 1.4"},
      {:req,         "~> 0.5"},
      {:phoenix_pubsub, "~> 2.1"},
      {:telemetry,   "~> 1.2"}
    ]
  end

  defp aliases do
    [
      compile: [
        "cmd --cd #{@team_jay_dir} mix compile --warnings-as-errors"
      ],
      test: [
        "cmd --cd #{@team_jay_dir} mix test #{@luna_test_dir}"
      ],
      migrate: [
        "cmd --cd #{@team_jay_dir} mix luna.migrate"
      ]
    ]
  end
end
