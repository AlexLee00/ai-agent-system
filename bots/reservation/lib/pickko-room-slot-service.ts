type RoomSlotServiceDeps = {
  delay: (ms: number) => Promise<unknown>;
  log: (message: string) => void;
  maskPhone: (phone: string) => string;
  buildStageError: (code: string, message: string) => Error;
};

export function createPickkoRoomSlotService({
  delay,
  log,
  maskPhone,
  buildStageError,
}: RoomSlotServiceDeps) {
  async function selectRoomAndSlot(
    page: any,
    {
      date,
      room,
      stNo,
      timeSlots,
      effectiveTimeSlots,
      slotCandidates,
      customerName,
      phoneNoHyphen,
      mode,
    }: {
      date: string;
      room: string;
      stNo: string;
      timeSlots: string[];
      effectiveTimeSlots: string[];
      slotCandidates: Array<{ start: string; end: string; durationMin: number; reason: string }>;
      customerName: string;
      phoneNoHyphen: string;
      mode: string;
    },
  ) {
    log('\n[6단계] 룸 & 시간 선택');

    log(`[6-1] ${room} 룸 탭 클릭`);
    await page.evaluate((roomName: string) => {
      const els = document.querySelectorAll('*');
      for (const el of Array.from(els)) {
        const htmlEl = el as HTMLElement;
        if (htmlEl.children.length === 0 && (htmlEl.textContent || '').includes(roomName) && (htmlEl.textContent || '').includes('스터디')) {
          htmlEl.click();
          return;
        }
      }
    }, room);
    log(`✅ ${room} 룸 탭 클릭 완료`);
    await delay(1500);

    log(`[6-2] 스케줄 갱신 대기중... (date=${date}, st_no=${stNo})`);
    let scheduleReady = false;
    for (let i = 0; i < 20; i++) {
      scheduleReady = await page.evaluate((dateStr: string, stNoStr: string) => {
        return !!document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"]`);
      }, date, stNo);
      if (scheduleReady) break;
      await delay(250);
    }
    log(scheduleReady ? '✅ 스케줄 갱신 감지' : '⚠️ 스케줄 갱신 감지 실패');

    log('[6-3] 시간표 영역으로 스크롤');
    try {
      const scrolled = await page.evaluate((dateStr: string, stNoStr: string) => {
        const el = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"]`);
        if (!el) return false;
        (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
        return true;
      }, date, stNo);
      log(scrolled ? '✅ 스크롤 완료' : '⚠️ 스크롤 대상을 못 찾음');
    } catch (e: any) {
      log(`⚠️ 스크롤 실패: ${e.message}`);
    }
    await delay(500);

    log(`[6-4] 시간 선택: ${effectiveTimeSlots.length}개 슬롯 순차 선택 (전체 ${timeSlots.length}개 중)`);

    let chosen: any = null;
    let attemptCount = 0;
    log(`   ⏰ 후보 구간 ${slotCandidates.length}개 생성: ${slotCandidates.map((c) => `${c.start}~${c.end}`).join(', ')}`);

    for (const candidate of slotCandidates) {
      log(`   ⏰ 후보: ${candidate.start} / ${candidate.end} / 기간 ${candidate.durationMin}분 / reason=${candidate.reason}`);

      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          log(`   ⏰ 재시도 #${attempt + 1}: 스케줄 갱신 대기 후 재시도...`);
          await delay(1500);
        }
        attemptCount++;
        log(`   ⏰ 시도 #${attemptCount}: ${candidate.start} -> ${candidate.end}`);

        const s = candidate.start;
        const e = candidate.end;
        const durationMin = candidate.durationMin;
        log(`      범위: ${s} ~ ${e}`);

        const res = await page.evaluate((
          dateStr: string,
          stNoStr: string,
          start: string,
          end: string,
          duration: number,
          custName: string,
          phoneLast4: string,
        ) => {
          const debug: any = {
            methodUsed: null,
            startExists: false,
            endExists: false,
            startUsed: false,
            endUsed: false,
            startClicked: false,
            endClicked: false,
            okMid: true,
            alreadyRegistered: false,
            alreadyRegisteredBy: null,
            errors: [],
          };

          let startLi: Element | null = null;
          let endLi: Element | null = null;

          startLi = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"][start="${start}"][mb_no=""]`);
          endLi = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"][start="${end}"][mb_no=""]`);
          if (startLi && endLi) debug.methodUsed = 'Method-1: li[date][st_no][start][mb_no=""]';

          if (!startLi || !endLi) {
            startLi = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"][start="${start}"]`);
            endLi = document.querySelector(`li[date="${dateStr}"][st_no="${stNoStr}"][start="${end}"]`);
            if (startLi && endLi) debug.methodUsed = 'Method-2: li[date][st_no][start]';
          }

          if (!startLi || !endLi) {
            startLi = document.querySelector(`li[st_no="${stNoStr}"][start="${start}"]`);
            endLi = document.querySelector(`li[st_no="${stNoStr}"][start="${end}"]`);
            if (startLi && endLi) debug.methodUsed = 'Method-3: li[st_no][start]';
          }

          if (!startLi || !endLi) {
            const allLis = document.querySelectorAll('li[start]');
            for (const li of Array.from(allLis)) {
              const liStart = li.getAttribute('start');
              const liStNo = li.getAttribute('st_no');
              if (liStart === start && liStNo === stNoStr && !startLi) startLi = li;
              if (liStart === end && liStNo === stNoStr && !endLi) endLi = li;
            }
            if (startLi && endLi) debug.methodUsed = 'Method-4: li[start] attribute loop';
          }

          debug.startExists = !!startLi;
          debug.endExists = !!endLi;
          if (startLi) debug.startUsed = startLi.classList.contains('used');
          if (endLi) debug.endUsed = endLi.classList.contains('used');

          if (debug.startUsed && startLi) {
            const slotText = ((startLi.textContent || '') as string).replace(/\s+/g, ' ').trim();
            const mbNo = startLi.getAttribute('mb_no') || '';
            const mbName = startLi.getAttribute('mb_name') || '';
            const combined = [slotText, mbNo, mbName].join(' ');

            const nameMatch = custName && custName.length >= 2 && combined.includes(custName);
            const phoneMatch = phoneLast4 && (combined.includes(phoneLast4) || mbNo.endsWith(phoneLast4));
            if (nameMatch || phoneMatch) {
              debug.alreadyRegistered = true;
              debug.alreadyRegisteredBy = (slotText || mbName || mbNo).slice(0, 40);
            }
          }

          if (startLi && !debug.startUsed) debug.startClicked = true;
          if (endLi && !debug.endUsed) debug.endClicked = true;

          if (duration > 30 && debug.startClicked && debug.endClicked) {
            const [sh, sm] = start.split(':').map(Number);
            const startMin = sh * 60 + sm;
            for (let t = startMin; t < startMin + duration; t += 30) {
              const hh = String(Math.floor(t / 60)).padStart(2, '0');
              const mm = String(t % 60).padStart(2, '0');
              const midLi = document.querySelector(`li[st_no="${stNoStr}"][start="${hh}:${mm}"]`);
              if (!(midLi && !midLi.classList.contains('used'))) {
                debug.okMid = false;
                debug.errors.push(`Mid-slot blocked: ${hh}:${mm}`);
                break;
              }
            }
          }

          if (debug.startClicked && debug.endClicked && debug.okMid) {
            (startLi as HTMLElement).click();
            (endLi as HTMLElement).click();
          }

          return debug;
        }, date, stNo, s, e, durationMin, customerName, phoneNoHyphen.slice(-4));

        if (res.methodUsed) log(`       ✅ ${res.methodUsed}`);
        log(`       ├─ start: exists=${res.startExists} used=${res.startUsed} clickable=${res.startClicked}`);
        log(`       ├─ end: exists=${res.endExists} used=${res.endUsed} clickable=${res.endClicked}`);
        log(`       └─ mid: ok=${res.okMid} ${res.errors.length > 0 ? `(${res.errors.join(', ')})` : ''}`);

        if (res.alreadyRegistered) {
          log(`       ✅ 동일 고객 슬롯 이미 등록됨: "${res.alreadyRegisteredBy}" → 완료 처리`);
          const alreadyErr: any = new Error(`슬롯 이미 등록됨: ${res.alreadyRegisteredBy}`);
          alreadyErr.code = 'ALREADY_REGISTERED';
          throw alreadyErr;
        }

        if (res.startClicked && res.endClicked && res.okMid) {
          chosen = {
            start: s,
            end: e,
            method: res.methodUsed,
            reason: candidate.reason,
            durationMin,
          };
          log('       🎯 **시간 선택 성공!**');
          break;
        }

        await delay(350);
      }

      if (chosen) break;
    }

    if (!chosen) {
      if (mode === 'ops') {
        const errorAlert = {
          phone: phoneNoHyphen,
          date,
          requestTime: `${timeSlots[0]}~${timeSlots[timeSlots.length - 1]}`,
          room,
          reason: `해당 시간대 모두 예약됨 (최대 ${timeSlots.length}개 슬롯 확인)`,
        };
        log('\n🚨 [OPS-CRITICAL] 시간 선택 실패');
        log(`   • 고객 번호: ${maskPhone(errorAlert.phone)}`);
        log(`   • 예약 날짜: ${errorAlert.date}`);
        log(`   • 요청 시간: ${errorAlert.requestTime}`);
        log(`   • 요청 룸: ${errorAlert.room}`);
        log(`   • 실패 사유: ${errorAlert.reason}`);
        throw buildStageError('TIME_SLOT_SELECT_FAILED', '[OPS-CRITICAL] 시간 선택 실패 - 예약 불가능한 시간대');
      }

      log('⚠️ [DEV] 시간 선택 실패: 모든 슬롯이 예약됨');
      throw buildStageError('TIME_SLOT_SELECT_FAILED', '[DEV] 시간 선택 실패');
    }

    log(`[6-5] ✅ 시간 선택 완료: ${chosen.start}~${chosen.end} (방법: ${chosen.method || 'unknown'}, reason=${chosen.reason || 'unknown'}, duration=${chosen.durationMin || 0}분)`);
    return chosen;
  }

  return {
    selectRoomAndSlot,
  };
}
