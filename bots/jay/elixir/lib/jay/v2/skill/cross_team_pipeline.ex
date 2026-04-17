defmodule Jay.V2.Skill.CrossTeamPipeline do
  @moduledoc """
  CrossTeamPipeline — 7개 크로스팀 파이프라인 이벤트 발행.
  Jay.V2.Topics의 broadcast 헬퍼를 래핑해 Commander에서 통일된 인터페이스 제공.

  지원 파이프라인:
  - luna->blog: 투자 분석 → 콘텐츠
  - darwin->all: R&D 결과 전파
  - sigma->all: directive 실행
  - claude->all: 모니터링 결과
  - ska->blog, blog->luna, luna->ska
  """

  use Jido.Action,
    name: "jay_v2_cross_team_pipeline",
    description: "Publish cross-team events via JayBus Topics",
    schema: Zoi.object(%{
      pipeline: Zoi.default(Zoi.string(), ""),
      event_type: Zoi.default(Zoi.string(), ""),
      payload: Zoi.default(Zoi.any(), %{})
    })

  @pipeline_to_topic %{
    "luna->blog" => :luna_to_blog,
    "ska->blog" => :ska_to_blog,
    "blog->ska" => :blog_to_ska,
    "ska->luna" => :ska_to_luna,
    "claude->all" => :claude_to_all,
    "blog->luna" => :blog_to_luna,
    "luna->ska" => :luna_to_ska
  }

  @valid_pipelines Map.keys(@pipeline_to_topic)

  @impl Jido.Action
  def run(params, _ctx) do
    pipeline = Map.get(params, :pipeline, "")
    payload = Map.get(params, :payload, %{})

    case Map.get(@pipeline_to_topic, pipeline) do
      nil ->
        {:error, "unknown pipeline: #{pipeline}. valid: #{Enum.join(@valid_pipelines, ", ")}"}

      topic ->
        Jay.V2.Topics.broadcast(topic, payload)
        {:ok, %{pipeline: pipeline, topic: topic, broadcasted: true}}
    end
  rescue
    _ -> {:error, "broadcast failed (JayBus not started)"}
  end
end
