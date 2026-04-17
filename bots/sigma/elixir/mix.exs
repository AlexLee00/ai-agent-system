defmodule Sigma.MixProject do
  use Mix.Project

  @team_jay_dir Path.expand("../../../elixir/team_jay", __DIR__)
  @sigma_test_files Path.wildcard(Path.join([__DIR__, "test", "sigma", "v2", "*_test.exs"]))

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

    [
      compile: [
        "cmd --cd #{@team_jay_dir} mix compile"
      ],
      test: [
        "cmd --cd #{@team_jay_dir} mix test #{sigma_test_args}"
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
