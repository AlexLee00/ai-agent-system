defmodule TeamJay.MixProject do
  use Mix.Project

  def project do
    [
      app: :team_jay,
      version: "0.1.0",
      elixir: "~> 1.19",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger, :runtime_tools],
      mod: {TeamJay.Application, []}
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:ecto_sql, "~> 3.12"},
      {:postgrex, ">= 0.0.0"},
      {:req, "~> 0.5"},
      {:jason, "~> 1.4"},
      {:quantum, "~> 3.5"}
    ]
  end
end
