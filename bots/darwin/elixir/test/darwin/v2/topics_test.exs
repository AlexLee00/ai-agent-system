defmodule Darwin.V2.TopicsTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Topics

  describe "토픽 문자열 상수" do
    test "paper_discovered" do
      assert Topics.paper_discovered() == "darwin.paper.discovered"
    end

    test "paper_evaluated" do
      assert Topics.paper_evaluated() == "darwin.paper.evaluated"
    end

    test "verification_passed" do
      assert Topics.verification_passed() == "darwin.verification.passed"
    end

    test "applied/1 팀별 토픽" do
      assert Topics.applied("luna") == "darwin.applied.luna"
      assert Topics.applied("blog") == "darwin.applied.blog"
    end

    test "autonomy_upgraded" do
      assert Topics.autonomy_upgraded() == "darwin.autonomy.upgraded"
    end

    test "shadow_result" do
      assert Topics.shadow_result() == "darwin.shadow.result"
    end

    test "모든 토픽이 darwin. 접두사" do
      topics = [
        Topics.paper_discovered(),
        Topics.paper_evaluated(),
        Topics.paper_rejected(),
        Topics.plan_ready(),
        Topics.implementation_ready(),
        Topics.verification_passed(),
        Topics.verification_failed(),
        Topics.keyword_evolved(),
        Topics.autonomy_upgraded(),
        Topics.autonomy_degraded(),
        Topics.shadow_result()
      ]

      Enum.each(topics, fn topic ->
        assert String.starts_with?(topic, "darwin."), "#{topic} 접두사 오류"
      end)
    end
  end
end
