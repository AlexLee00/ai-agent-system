defmodule TeamJay.Blog.Topics do
  @moduledoc """
  블로그팀 이벤트 버스용 토픽 정의.

  현재는 Phase 1 Elixir 전환을 위한 안전한 스캐폴드다.
  메인 운영 경로는 여전히 Node.js + launchd를 사용하고,
  이 모듈은 이후 PubSub/GenServer 전환의 고정 토픽 이름을 제공한다.
  """

  def schedule, do: "blog:schedule"
  def research_done, do: "blog:research_done"
  def draft_ready(writer), do: "blog:draft_ready:#{writer}"
  def quality_approved, do: "blog:quality_approved"
  def handoff(target), do: "blog:handoff:#{target}"
  def image_ready(post_type), do: "blog:image_ready:#{post_type}"
  def published, do: "blog:published"
  def feedback(post_id), do: "blog:feedback:#{post_id}"
  def social(channel), do: "blog:social:#{channel}"
end
