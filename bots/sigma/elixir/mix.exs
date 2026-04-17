defmodule Sigma.MixProject do
  use Mix.Project

  @team_jay_dir Path.expand("../../../elixir/team_jay", __DIR__)
  @sigma_test_dir Path.expand("../test", __DIR__)

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
    [
      compile: [
        "cmd --cd #{@team_jay_dir} mix compile --warnings-as-errors"
      ],
      test: [
        "cmd --cd #{@team_jay_dir} mix test #{@sigma_test_dir}"
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
