defmodule TeamJay.Ska.PubSub do
  @moduledoc """
  스카팀 이벤트 버스 (Registry 기반 PubSub)
  블로팀 패턴 재사용!

  토픽:
    - :failure_reported   — 실패 감지 이벤트
    - :failure_resolved   — 자동 복구 완료
    - :parsing_degraded   — 파싱 Level 1 → 2 → 3 강등
    - :selector_promoted  — 셀렉터 승격
    - :selector_deprecated — 셀렉터 폐기
    - :phase_changed      — 자율 단계 전환 (Phase 1→2→3)
    - :weekly_report      — 주간 리포트 (Phase 3)
  """

  @registry TeamJay.SkaBus

  def subscribe(topic), do: Registry.register(@registry, topic, [])

  def broadcast(topic, message) do
    Registry.dispatch(@registry, topic, fn entries ->
      Enum.each(entries, fn {pid, _meta} ->
        send(pid, {:ska_event, topic, message})
      end)
    end)
  end

  # ─── 편의 함수 ───────────────────────────────────────────

  def broadcast_failure(failure) do
    broadcast(:failure_reported, failure)
  end

  def broadcast_resolved(failure_id, strategy) do
    broadcast(:failure_resolved, %{failure_id: failure_id, strategy: strategy})
  end

  def broadcast_parsing_degraded(target, from_level, to_level) do
    broadcast(:parsing_degraded, %{
      target: target,
      from_level: from_level,
      to_level: to_level,
      at: DateTime.utc_now()
    })
  end

  def broadcast_selector_promoted(target, selector_id) do
    broadcast(:selector_promoted, %{target: target, selector_id: selector_id})
  end

  def broadcast_selector_deprecated(target, selector_id) do
    broadcast(:selector_deprecated, %{target: target, selector_id: selector_id})
  end

  def broadcast_phase_changed(from_phase, to_phase) do
    broadcast(:phase_changed, %{from: from_phase, to: to_phase, at: DateTime.utc_now()})
  end
end
