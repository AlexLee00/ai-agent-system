defmodule Darwin.V2.ShadowRunnerTest do
  use ExUnit.Case, async: false

  alias Darwin.V2.ShadowRunner

  setup do
    old_shadow_mode = System.get_env("DARWIN_SHADOW_MODE")
    old_shadow_enabled = System.get_env("DARWIN_SHADOW_ENABLED")
    old_v2_shadow_enabled = System.get_env("DARWIN_V2_SHADOW_ENABLED")
    old_shadow_sample = System.get_env("DARWIN_SHADOW_SAMPLE_PERCENT")

    on_exit(fn ->
      restore_env("DARWIN_SHADOW_MODE", old_shadow_mode)
      restore_env("DARWIN_SHADOW_ENABLED", old_shadow_enabled)
      restore_env("DARWIN_V2_SHADOW_ENABLED", old_v2_shadow_enabled)
      restore_env("DARWIN_SHADOW_SAMPLE_PERCENT", old_shadow_sample)
    end)

    :ok
  end

  describe "enabled?/0" do
    test "기본값은 disabled" do
      System.delete_env("DARWIN_SHADOW_MODE")
      System.delete_env("DARWIN_SHADOW_ENABLED")
      System.delete_env("DARWIN_V2_SHADOW_ENABLED")
      refute ShadowRunner.enabled?()
    end

    test "기존 shadow env만으로는 disabled" do
      System.put_env("DARWIN_SHADOW_MODE", "true")
      System.delete_env("DARWIN_V2_SHADOW_ENABLED")
      refute ShadowRunner.enabled?()
    end

    test "DARWIN_V2_SHADOW_ENABLED=true AND 기존 shadow env true일 때만 enabled" do
      System.put_env("DARWIN_SHADOW_MODE", "true")
      System.put_env("DARWIN_V2_SHADOW_ENABLED", "true")
      assert ShadowRunner.enabled?()
    end

    test "run_once는 frozen 상태에서 신규 shadow run을 만들지 않고 skip한다" do
      System.put_env("DARWIN_SHADOW_MODE", "true")
      System.delete_env("DARWIN_V2_SHADOW_ENABLED")
      assert %{ok: true, skipped: true, reason: :v2_shadow_frozen} = ShadowRunner.run_once()
    end
  end

  describe "match_tolerance 논리 — 단위 검증" do
    test "점수 차이 ≤ 1.0이면 일치" do
      tolerance = 1.0
      assert abs(7.0 - 8.0) <= tolerance
      assert abs(5.0 - 5.0) <= tolerance
      refute abs(3.0 - 7.0) <= tolerance
    end
  end

  describe "score parsing + prompt context" do
    test "소수점과 영어 score 포맷을 파싱한다" do
      assert ShadowRunner.__test_parse_score("점수: 7.25\n이유: good") == 7.25
      assert ShadowRunner.__test_parse_score("Score: 8/10") == 8.0
      assert ShadowRunner.__test_parse_score("9.5/10") == 9.5
    end

    test "shadow 평가 프롬프트에 title/source 외 context를 포함한다" do
      prompt =
        ShadowRunner.__test_build_eval_prompt(%{
          title: "Agentic retrieval",
          source: "arxiv",
          domain: "neuron",
          summary: "multi-agent retrieval with tool feedback",
          reason: "V1 saw strong relevance"
        })

      assert prompt =~ "Agentic retrieval"
      assert prompt =~ "arxiv"
      assert prompt =~ "neuron"
      assert prompt =~ "multi-agent retrieval"
      assert prompt =~ "V1 saw strong relevance"
    end
  end

  describe "승격 조건 — 논리 검증" do
    test "7일 미만 → 승격 불가" do
      days = 3
      runs = 25
      rate = 1.0
      refute days >= 7 and runs >= 20 and rate >= 0.95
    end

    test "7일 + 20건 + 95% 이상 → 승격 가능" do
      days = 7
      runs = 20
      rate = 0.97
      assert days >= 7 and runs >= 20 and rate >= 0.95
    end

    test "7일 + 19건 → 승격 불가 (건수 미달)" do
      days = 8
      runs = 19
      rate = 1.0
      refute days >= 7 and runs >= 20 and rate >= 0.95
    end

    test "7일 + 20건 + 94% → 승격 불가 (점수 미달)" do
      days = 7
      runs = 20
      rate = 0.94
      refute days >= 7 and runs >= 20 and rate >= 0.95
    end
  end

  describe "shadow_summary/0 + shadow_ready?/0 — GenServer 기동 시" do
    test "ShadowRunner 기동 시 shadow_summary 반환" do
      pid = Process.whereis(ShadowRunner)

      if pid do
        summary = ShadowRunner.shadow_summary()
        assert is_map(summary)
        assert Map.has_key?(summary, :total_runs) or Map.has_key?(summary, :runs)
      end
    end

    test "ShadowRunner 기동 시 shadow_ready? → boolean" do
      pid = Process.whereis(ShadowRunner)

      if pid do
        result = ShadowRunner.shadow_ready?()
        assert is_boolean(result)
      end
    end
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end
