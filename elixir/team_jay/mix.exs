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
      # 기존 의존성
      {:ecto_sql, "~> 3.12"},
      {:postgrex, "~> 0.20"},
      {:req, "~> 0.5"},
      {:jason, "~> 1.4"},
      {:quantum, "~> 3.5"},

      # 시그마팀 리모델링 v3 (2026-04-17 Phase 0)
      {:jido, "~> 2.2"},
      {:jido_action, "~> 2.2"},
      {:jido_signal, "~> 2.1"},
      {:jido_ai, "~> 2.1"},
      {:req_llm, "~> 1.9"},

      # 보강 의존성
      {:opentelemetry, "~> 1.7"},
      {:opentelemetry_exporter, "~> 1.7"},
      {:pgvector, "~> 0.3"},

      # Phase 1 명시적 추가 (transitive → explicit)
      {:zoi, "~> 0.17"},
      {:yaml_elixir, "~> 2.11"}
    ]
  end
end
