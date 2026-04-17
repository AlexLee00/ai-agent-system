defmodule Jay.MixProject do
  use Mix.Project

  @team_jay_dir Path.expand("../../../elixir/team_jay", __DIR__)
  @jay_test_files Path.wildcard(Path.join([__DIR__, "test", "jay", "v2", "**", "*_test.exs"]))

  def project do
    [
      app: :jay,
      version: "2.0.0",
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
    jay_test_args = Enum.join(@jay_test_files, " ")

    [
      compile: [
        "cmd --cd #{@team_jay_dir} mix compile"
      ],
      test: [
        "cmd --cd #{@team_jay_dir} mix test #{jay_test_args}"
      ]
    ]
  end
end
