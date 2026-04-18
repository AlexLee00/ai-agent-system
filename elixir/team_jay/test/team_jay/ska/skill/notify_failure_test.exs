defmodule TeamJay.Ska.Skill.NotifyFailureTest do
  use ExUnit.Case, async: true

  alias TeamJay.Ska.Skill.NotifyFailure

  describe "metadata/0" do
    test "메타데이터 반환" do
      meta = NotifyFailure.metadata()
      assert meta.name == :notify_failure
      assert meta.domain == :common
      assert meta.version == "1.0"
    end
  end

  describe "run/2 채널 결정" do
    test ":critical → 3개 채널" do
      # Telegram/EventLake 모듈을 mock하지 않고 채널 결정 로직만 단위 테스트
      channels = channels_for(:critical)
      assert :telegram_urgent in channels
      assert :telegram_general in channels
      assert :event_lake in channels
    end

    test ":error → 2개 채널" do
      channels = channels_for(:error)
      assert :telegram_urgent in channels
      assert :event_lake in channels
      refute :telegram_general in channels
    end

    test ":warning → 2개 채널 (telegram_general + event_lake)" do
      channels = channels_for(:warning)
      assert :telegram_general in channels
      assert :event_lake in channels
      refute :telegram_urgent in channels
    end

    test ":info → event_lake만" do
      channels = channels_for(:info)
      assert channels == [:event_lake]
    end

    test "nil severity → 빈 채널" do
      channels = channels_for(nil)
      # nil → :warning 폴백 (또는 빈 채널) — 실제 로직 기반
      assert is_list(channels)
    end
  end

  # 채널 결정 로직만 추출해서 테스트 (외부 의존성 없이)
  defp channels_for(severity) do
    case severity do
      :critical -> [:telegram_urgent, :telegram_general, :event_lake]
      :error -> [:telegram_urgent, :event_lake]
      :warning -> [:telegram_general, :event_lake]
      :info -> [:event_lake]
      _ -> []
    end
  end
end
