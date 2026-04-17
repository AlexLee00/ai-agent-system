defmodule Jay.Core.MixProject do
  use Mix.Project

  def project do
    [
      app: :jay_core,
      version: "1.0.0",
      elixir: "~> 1.19",
      start_permanent: false,
      deps: deps(),
      elixirc_paths: elixirc_paths(Mix.env())
    ]
  end

  # 라이브러리 전용 — Application 없음
  def application do
    [extra_applications: [:logger, :runtime_tools]]
  end

  defp deps do
    [
      {:ecto_sql, "~> 3.12"},
      {:postgrex, "~> 0.20"},
      {:req, "~> 0.5"},
      {:jason, "~> 1.4"},
      {:quantum, "~> 3.5"},
      {:pgvector, "~> 0.3"},
      {:phoenix_pubsub, "~> 2.1"},
      {:telemetry, "~> 1.2"},
      {:opentelemetry, "~> 1.7"},
      {:opentelemetry_exporter, "~> 1.7"}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]
end
