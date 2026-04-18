# 스킬 마이그레이션 플레이북

새 에이전트가 스킬을 가져다 쓰거나, 기존 에이전트를 스킬 기반으로 전환하는 절차.

## 1단계: 기존 하드코딩 루틴 식별

```
현재 에이전트 코드에서:
- 세션 만료 체크 → :detect_session_expiry
- 알림 발송 → :notify_failure
- 메트릭 기록 → :persist_cycle_metrics
- 복구 트리거 → :trigger_recovery
- DB 체크 → :audit_db_integrity
```

## 2단계: Shadow 모드로 전환

```elixir
# 기존 하드코딩 유지 + Skill 병행 실행
defp process_cycle(html) do
  if shadow_mode?() do
    legacy = legacy_process(html)
    skill = skill_process(html)
    Task.start(fn -> compare_and_log(:agent_name, legacy, skill) end)
    legacy  # 반환값은 기존 것
  else
    skill_process(html)
  end
end

defp shadow_mode? do
  Application.get_env(:ska, :skill_shadow_mode, false)
end
```

## 3단계: Skill 기반 재구성

```elixir
alias TeamJay.Ska.SkillRegistry, as: Skill

defp process_cycle(html) do
  start = System.monotonic_time(:millisecond)

  with {:ok, session} <- Skill.execute(:detect_session_expiry,
         %{agent: :my_agent, response_html: html, status_code: 200}),
       :healthy <- session[:status] do

    elapsed = System.monotonic_time(:millisecond) - start
    Skill.execute(:persist_cycle_metrics, %{
      agent: :my_agent, success: true,
      duration_ms: elapsed, items_processed: 1
    })

    {:ok, :processed}
  else
    :expired ->
      Skill.execute(:trigger_recovery, %{
        agent: :my_agent, failure_type: :session_expired, context: %{}
      })
      Skill.execute(:notify_failure, %{
        agent: :my_agent, severity: :error, message: "세션 만료", metadata: %{}
      })
      {:error, :session_expired}
  end
end
```

## 4단계: Shadow 검증 (7일)

- `SKA_SKILL_SHADOW_MODE=true` 설정
- `ska_skill_execution_log` 기록 확인
- Legacy vs Skill 결과 불일치 0건 확인 후 전환

## 5단계: Production 전환

```bash
# Shadow 모드 비활성화 → Skill만 사용
launchctl setenv SKA_SKILL_SHADOW_MODE false
```
