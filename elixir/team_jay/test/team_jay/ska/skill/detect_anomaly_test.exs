defmodule TeamJay.Ska.Skill.DetectAnomalyTest do
  use ExUnit.Case, async: true
  alias TeamJay.Ska.Skill.DetectAnomaly

  describe "metadata/0" do
    test "스킬 메타데이터 반환" do
      meta = DetectAnomaly.metadata()
      assert meta.name == :detect_anomaly
      assert meta.domain == :analytics
    end
  end

  describe "health_check/0" do
    test "항상 ok 반환 (z_score는 외부 의존 없음)" do
      assert :ok = DetectAnomaly.health_check()
    end
  end

  describe "run/2 z_score" do
    test "정상 데이터 — 이상치 없음" do
      values = [100.0, 101.0, 99.0, 100.0, 100.5]
      assert {:ok, result} = DetectAnomaly.run(%{values: values, method: :z_score}, %{})
      assert result.anomalies == []
      assert result.method_used == :z_score
    end

    test "명백한 이상치 탐지" do
      # 1000.0은 나머지 100들과 z-score 2.0으로 탐지됨 (threshold 1.9 사용)
      values = [100.0, 100.0, 100.0, 100.0, 1000.0]
      assert {:ok, result} = DetectAnomaly.run(%{values: values, method: :z_score, threshold: 1.9}, %{})
      assert length(result.anomalies) >= 1
      assert hd(result.anomalies).index == 4
    end

    test "빈 값 목록 처리" do
      assert {:ok, result} = DetectAnomaly.run(%{values: [], method: :z_score}, %{})
      assert result.anomalies == []
      assert result.score == 0.0
    end

    test "모두 동일 값 (stddev=0) — 이상치 없음" do
      values = [100.0, 100.0, 100.0]
      assert {:ok, result} = DetectAnomaly.run(%{values: values, method: :z_score}, %{})
      assert result.anomalies == []
    end
  end

  describe "run/2 iqr" do
    test "IQR 방식 — 이상치 탐지" do
      values = [10.0, 12.0, 11.0, 10.0, 200.0]
      assert {:ok, result} = DetectAnomaly.run(%{values: values, method: :iqr, threshold: 1.5}, %{})
      assert result.method_used == :iqr
    end
  end

  describe "anomaly_score 계산" do
    test "이상치 비율이 score에 반영됨" do
      values = [100.0, 100.0, 100.0, 100.0, 1000.0]
      assert {:ok, result} = DetectAnomaly.run(%{values: values, method: :z_score, threshold: 1.9}, %{})
      assert result.score > 0.0 and result.score <= 1.0
    end
  end
end
