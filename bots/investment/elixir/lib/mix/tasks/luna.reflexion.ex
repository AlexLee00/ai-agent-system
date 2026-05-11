defmodule Mix.Tasks.Luna.Reflexion do
  @moduledoc """
  Reflexion 3-Layer 실행 믹스 태스크.

  사용법:
    mix luna.reflexion --layer=1 --trade-id=123
    mix luna.reflexion --layer=2 --batch
    mix luna.reflexion --layer=2 --date=2026-05-11
    mix luna.reflexion --layer=3 --batch
    mix luna.reflexion --layer=3 --end-date=2026-05-11
  """
  use Mix.Task

  @shortdoc "루나 Reflexion 3-Layer 실행 (--layer=1|2|3)"

  @impl Mix.Task
  def run(args) do
    Application.ensure_all_started(:luna)

    layer    = find_opt(args, "--layer") |> parse_int(1)
    trade_id = find_opt(args, "--trade-id") |> parse_int(nil)
    date     = find_opt(args, "--date")
    end_date = find_opt(args, "--end-date")

    result = case layer do
      1 ->
        id = trade_id || raise "L1은 --trade-id=<id> 필수"
        Luna.V2.Reflexion.L1Immediate.evaluate(id)

      2 ->
        Luna.V2.Reflexion.L2Daily.run(date)

      3 ->
        Luna.V2.Reflexion.L3Weekly.run(end_date)

      _ ->
        Mix.raise("--layer 값은 1, 2, 3 중 하나여야 합니다")
    end

    case result do
      {:ok, :skipped} ->
        IO.puts("[Reflexion L#{layer}] 샘플 부족, 스킵")

      {:ok, data} ->
        IO.puts("[Reflexion L#{layer}] 완료:")
        IO.inspect(data, pretty: true)

      {:error, reason} ->
        Mix.raise("[Reflexion L#{layer}] 실패: #{inspect(reason)}")
    end
  end

  defp find_opt(args, key) do
    Enum.find_value(args, fn arg ->
      if String.starts_with?(arg, "#{key}="), do: String.split(arg, "=", parts: 2) |> List.last()
    end)
  end

  defp parse_int(nil, default), do: default
  defp parse_int(str, _default) do
    case Integer.parse(str) do
      {n, _} -> n
      :error -> nil
    end
  end
end
