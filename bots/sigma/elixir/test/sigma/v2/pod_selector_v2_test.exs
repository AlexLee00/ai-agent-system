defmodule Sigma.V2.PodSelectorV2Test do
  use ExUnit.Case, async: true

  @moduletag :phase_p

  @sigma_lib Path.join(__DIR__, "../../../lib")

  describe "Sigma.V2.PodSelectorV2 — Kill Switch OFF (ε-greedy fallback)" do
    test "Kill switch 미설정 시 {:ok, pod} 반환" do
      System.delete_env("SIGMA_POD_DYNAMIC_V2_ENABLED")
      result = Sigma.V2.PodSelectorV2.select_best_pod("luna", %{})
      assert match?({:ok, pod} when pod in ~w(trend growth risk), result)
    end

    test "Kill switch false 시 {:ok, pod} 반환" do
      System.put_env("SIGMA_POD_DYNAMIC_V2_ENABLED", "false")
      result = Sigma.V2.PodSelectorV2.select_best_pod("darwin", %{})
      assert match?({:ok, pod} when pod in ~w(trend growth risk), result)
    after
      System.delete_env("SIGMA_POD_DYNAMIC_V2_ENABLED")
    end
  end

  describe "Sigma.V2.PodSelectorV2 — Kill Switch ON" do
    test "UCB1 전략 선택 시 {:ok, pod} 반환" do
      System.put_env("SIGMA_POD_DYNAMIC_V2_ENABLED", "true")
      result = Sigma.V2.PodSelectorV2.select_best_pod("blog", %{strategy: :ucb1})
      assert match?({:ok, pod} when pod in ~w(trend growth risk), result)
    after
      System.delete_env("SIGMA_POD_DYNAMIC_V2_ENABLED")
    end

    test "Thompson Sampling 전략 선택 시 {:ok, pod} 반환" do
      System.put_env("SIGMA_POD_DYNAMIC_V2_ENABLED", "true")
      result = Sigma.V2.PodSelectorV2.select_best_pod("blog", %{strategy: :thompson})
      assert match?({:ok, pod} when pod in ~w(trend growth risk), result)
    after
      System.delete_env("SIGMA_POD_DYNAMIC_V2_ENABLED")
    end

    test "Contextual 전략 선택 시 {:ok, pod} 반환" do
      System.put_env("SIGMA_POD_DYNAMIC_V2_ENABLED", "true")
      result = Sigma.V2.PodSelectorV2.select_best_pod("claude", %{strategy: :contextual, target_team: "claude"})
      assert match?({:ok, pod} when pod in ~w(trend growth risk), result)
    after
      System.delete_env("SIGMA_POD_DYNAMIC_V2_ENABLED")
    end

    test "기본값 (전략 미지정) 시 {:ok, pod} 반환" do
      System.put_env("SIGMA_POD_DYNAMIC_V2_ENABLED", "true")
      result = Sigma.V2.PodSelectorV2.select_best_pod("justin", %{})
      assert match?({:ok, pod} when pod in ~w(trend growth risk), result)
    after
      System.delete_env("SIGMA_POD_DYNAMIC_V2_ENABLED")
    end
  end

  describe "Sigma.V2.PodSelectorV2 — update_reward/3" do
    test "유효한 pod_name으로 :ok 반환 (DB 없어도)" do
      result = Sigma.V2.PodSelectorV2.update_reward("trend", "luna", 0.8)
      assert result == :ok
    end

    test "다른 pod로 :ok 반환" do
      result = Sigma.V2.PodSelectorV2.update_reward("risk", "darwin", 0.3)
      assert result == :ok
    end

    test "잘못된 pod_name은 FunctionClauseError 또는 :ok" do
      result = Sigma.V2.PodSelectorV2.update_reward("invalid_pod", "luna", 0.5)
      assert result == :ok
    rescue
      FunctionClauseError -> assert true
    end
  end

  describe "Sigma.V2.PodSelectorV2 — pod_stats/2" do
    test "리스트 반환 (DB 없어도)" do
      result = Sigma.V2.PodSelectorV2.pod_stats("luna", 30)
      assert is_list(result)
    end
  end

  describe "Sigma.V2.PodSelectorV2 — 소스 구조 검증" do
    test "@epsilon 상수 존재" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/pod_selector_v2.ex"))
      assert src =~ "@epsilon"
    end

    test "@ucb1_c 상수 존재" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/pod_selector_v2.ex"))
      assert src =~ "@ucb1_c"
    end

    test "Thompson Sampling Beta 분포 구현 포함" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/pod_selector_v2.ex"))
      assert src =~ "sample_beta"
      assert src =~ "thompson"
    end

    test "Contextual 전략 구현 포함" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/pod_selector_v2.ex"))
      assert src =~ "contextual"
      assert src =~ "context_similarity"
    end

    test "sigma_pod_bandit_stats 테이블 참조" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/pod_selector_v2.ex"))
      assert src =~ "sigma_pod_bandit_stats"
    end

    test "sigma_pod_selection_log 테이블 참조" do
      src = File.read!(Path.join(@sigma_lib, "sigma/v2/pod_selector_v2.ex"))
      assert src =~ "sigma_pod_selection_log"
    end
  end
end
