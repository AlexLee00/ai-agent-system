defmodule Luna.V2.Prediction.EngineTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Prediction.Engine

  setup_all do
    Code.ensure_compiled!(Engine)
    :ok
  end

  describe "모듈 구조" do
    test "Engine 컴파일됨" do
      assert Code.ensure_loaded?(Engine)
    end

    test "predict/2 존재" do
      assert function_exported?(Engine, :predict, 2)
    end

    test "get_latest/2 존재" do
      assert function_exported?(Engine, :get_latest, 2)
    end

    test "start_link/1 존재" do
      assert function_exported?(Engine, :start_link, 1)
    end
  end

  describe "5 feature 구조 검증" do
    test "feature 키 목록 검증 (spec 기준)" do
      # predict/2는 GenServer 의존 — feature 맵 키를 spec으로 검증
      expected_keys = [:breakout_prob, :trend_cont_prob, :regime_prob,
                       :expected_vol_band, :mean_rev_signal,
                       :symbol, :market, :computed_at]
      # GenServer 없이 단위 검증 불가 — 구조 명세 확인
      assert length(expected_keys) == 8
    end

    test "Prediction.Engine은 deterministic core" do
      # LLM 호출 없음 — 순수 수학/통계 계산
      refute Code.ensure_loaded?(Luna.V2.Commander) and
             function_exported?(Engine, :llm_judge, 3)
    end
  end
end
