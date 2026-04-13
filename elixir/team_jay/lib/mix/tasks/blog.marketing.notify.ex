defmodule Mix.Tasks.Blog.Marketing.Notify do
  use Mix.Task

  @shortdoc "블로그팀 마케팅 확장 알림을 생성하거나 전송합니다"
  @requirements ["app.start"]

  @moduledoc """
  블로그팀 마케팅 확장 요약을 알림 메시지로 만들고,
  필요할 때 허브 알람으로 전송한다.

  기본값은 dry-run이며 실제 전송은 `--send`를 붙일 때만 수행한다.

  ## Examples

      mix blog.marketing.notify
      mix blog.marketing.notify --brief
      mix blog.marketing.notify --send
      mix blog.marketing.notify --send --brief --json
  """

  alias TeamJay.Blog.MarketingNotifier

  @impl Mix.Task
  def run(args) do
    {opts, _argv, _invalid} =
      OptionParser.parse(args,
        strict: [
          send: :boolean,
          brief: :boolean,
          json: :boolean
        ]
      )

    result =
      MarketingNotifier.notify(
        send: Keyword.get(opts, :send, false),
        style: if(Keyword.get(opts, :brief, false), do: :brief, else: :ops)
      )

    cond do
      Keyword.get(opts, :json, false) ->
        Mix.shell().info(Jason.encode_to_iodata!(result, pretty: true))

      result.sent ->
        Mix.shell().info("sent=true")
        Mix.shell().info(result.message)
        Mix.shell().info("response=#{inspect(result.response)}")

      true ->
        Mix.shell().info("sent=false (dry-run)")
        Mix.shell().info(result.message)
    end
  end
end
