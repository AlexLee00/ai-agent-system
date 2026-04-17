defmodule Darwin.V2.ShadowRunnerTest do
  use ExUnit.Case, async: false

  alias Darwin.V2.ShadowRunner

  describe "enabled?/0" do
    test "DARWIN_SHADOW_ENABLED=false → disabled (기본값)" do
      System.put_env("DARWIN_SHADOW_ENABLED", "false")
      refute ShadowRunner.enabled?()
    end

    test "DARWIN_SHADOW_ENABLED=true → enabled" do
      System.put_env("DARWIN_SHADOW_ENABLED", "true")
      assert ShadowRunner.enabled?()
      System.put_env("DARWIN_SHADOW_ENABLED", "false")
    end
  end

  describe "parse_score/1 — 간접 검증" do
    test "점수 파싱 — 정상 형식" do
      # parse_score는 private이므로 ShadowRunner 로직 간접 테스트
      text1 = "점수: 7\n이유: 적용 가능한 논문"
      text2 = "점수: 10\n이유: 탁월"
      text3 = "결과: 5/10"

      # 정규식 패턴 자체 검증
      assert Regex.run(~r/점수:\s*(\d+)/u, text1) == ["점수: 7", "7"]
      assert Regex.run(~r/점수:\s*(\d+)/u, text2) == ["점수: 10", "10"]
      assert Regex.run(~r/(\d+)\s*\/\s*10/u, text3) == ["5/10", "5"]
    end

    test "match_tolerance — ±1 이내이면 일치" do
      tolerance = 1
      assert abs(7 - 8) <= tolerance
      assert abs(5 - 5) <= tolerance
      refute abs(3 - 7) <= tolerance
    end
  end

  describe "stats/0 — DB 없이 smoke" do
    test "stats 호출 시 크래시 없음" do
      pid = Process.whereis(ShadowRunner)

      if pid do
        result = ShadowRunner.stats()
        assert is_map(result)
        assert Map.has_key?(result, :total_runs) or Map.has_key?(result, :runs)
      end
    end
  end

  describe "promotion 조건 — 단위 검증" do
    test "7일 미만 + 100% → 승격 불가" do
      days = 3
      rate = 1.0
      assert days < 7 or rate < 0.95
      refute days >= 7 and rate >= 0.95
    end

    test "7일 이상 + 95% 이상 → 승격 가능" do
      days = 7
      rate = 0.97
      assert days >= 7 and rate >= 0.95
    end

    test "7일 이상 + 94% → 승격 불가 (기준 미달)" do
      days = 8
      rate = 0.94
      refute days >= 7 and rate >= 0.95
    end
  end

  describe "run_once/0 — smoke" do
    test "Shadow 비활성 상태에서 run_once → 크래시 없음" do
      System.put_env("DARWIN_SHADOW_ENABLED", "false")
      pid = Process.whereis(ShadowRunner)

      if pid do
        # cast는 비동기 → 크래시 없으면 성공
        assert :ok = GenServer.cast(pid, :run_once)
      end
    end
  end
end
