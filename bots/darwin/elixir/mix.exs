defmodule Darwin.MixProject do
  use Mix.Project

  @team_jay_dir Path.expand("../../../elixir/team_jay", __DIR__)
  @darwin_test_dir Path.expand("test", __DIR__)

  def project do
    [
      app: :darwin,
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
      mod: {Darwin.Application, []}
    ]
  end

  defp deps do
    [
      {:jido, "~> 1.2"},
      {:jido_ai, "~> 0.4"},
      {:ecto_sql, "~> 3.11"},
      {:postgrex, ">= 0.0.0"},
      {:jason, "~> 1.4"},
      {:req, "~> 0.5"},
      {:bandit, "~> 1.5"},
      {:phoenix_pubsub, "~> 2.1"},
      {:telemetry, "~> 1.2"}
    ]
  end

  defp aliases do
    [
      compile: [
        "cmd --cd #{@team_jay_dir} mix compile --warnings-as-errors"
      ],
      test: [
        "cmd --cd #{@team_jay_dir} mix test #{@darwin_test_dir}"
      ],
      shadow: [
        "cmd --cd #{@team_jay_dir} mix run -e 'Darwin.V2.ShadowRunner.run_once() |> IO.inspect'"
      ],
      migrate: [
        "cmd --cd #{@team_jay_dir} mix darwin.migrate"
      ]
    ]
  end
end
