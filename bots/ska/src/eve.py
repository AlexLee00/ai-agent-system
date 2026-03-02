"""
ska-003/012: 이브(EVE) — 공공API 환경 요소 수집 모듈

수집 데이터:
  - 공휴일: 한국천문연구원 특일정보 API (data.go.kr)
  - 날씨:   기상청 단기예보 API (data.go.kr) — 성남시 분당구 nx=62, ny=122
  - 학사:   교육부 NEIS 학사일정 API (open.neis.go.kr) — 경기도 성남 고등학교
  - 축제:   전국문화축제표준데이터 API (data.go.kr) — 성남시 필터

타겟: bots/ska/db/ska.duckdb → environment_factors

실행:
  bots/ska/venv/bin/python bots/ska/src/eve.py [--days=30]
  bots/ska/venv/bin/python bots/ska/src/eve.py --holiday   # 공휴일만
  bots/ska/venv/bin/python bots/ska/src/eve.py --weather   # 날씨만
  bots/ska/venv/bin/python bots/ska/src/eve.py --neis      # 학사일정만
  bots/ska/venv/bin/python bots/ska/src/eve.py --festival  # 축제만
launchd:
  매일 06:00 — 날씨 (ska-008에서 연결 예정)
  매주 일요일 — 공휴일+학사+축제
"""
import sys
import os
import json
import re
import requests
import duckdb
from datetime import date as date_type, datetime, timedelta
from urllib.parse import urljoin

SECRETS_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', '..', 'reservation', 'secrets.json')
)
DUCKDB_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', 'db', 'ska.duckdb')
)

# 성남시 분당구 기상 격자 좌표
NX, NY = 62, 122


# ─── 유틸 ──────────────────────────────────────────────────────────────────────

def load_secrets():
    try:
        with open(SECRETS_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f'[EVE] ❌ secrets.json 로드 실패: {e}')
        return {}


def parse_args():
    days = 30
    flags = set()
    for arg in sys.argv[1:]:
        if arg.startswith('--days='):
            try:
                days = int(arg.split('=', 1)[1])
            except ValueError:
                print(f'[경고] --days 값 파싱 실패: {arg} — 기본값 30 사용')
        elif arg in ('--holiday', '--weather', '--neis', '--festival'):
            flags.add(arg[2:])
    if not flags:
        flags = {'holiday', 'weather', 'neis', 'festival'}
    return days, flags


def get_year_months(start: date_type, end: date_type):
    """start~end 기간에 포함된 (year, month) 목록"""
    result = []
    cur = start.replace(day=1)
    while cur <= end:
        result.append((cur.year, cur.month))
        if cur.month == 12:
            cur = cur.replace(year=cur.year + 1, month=1)
        else:
            cur = cur.replace(month=cur.month + 1)
    return result


def _follow_js_redirect(resp, timeout=10):
    """
    data.go.kr 일부 API의 JS 챌린지 리다이렉트 처리.
    HTML 응답 내 JS: x={o:'...', c:N}, z=M → rsu(M) = o[:N]+o[N+M:]
    """
    if 'text/html' not in resp.headers.get('Content-Type', ''):
        return resp
    match = re.search(r"x=\{o:'([^']+)',c:(\d+)\}", resp.text)
    if not match:
        return resp
    o_val = match.group(1)
    c_val = int(match.group(2))
    z_match = re.search(r',z=(\d+);', resp.text)
    z_val = int(z_match.group(1)) if z_match else 1
    redirected = o_val[:c_val] + o_val[c_val + z_val:]
    final_url = urljoin('http://api.data.go.kr', redirected)
    try:
        return requests.get(final_url, timeout=timeout)
    except Exception as e:
        print(f'[EVE] ⚠️ JS 리다이렉트 후속 요청 실패: {e}')
        return resp


def get_base_time():
    """현재 시각 기준 최근 사용 가능한 기상청 단기예보 발표 시간 (HH00)"""
    slots = [2, 5, 8, 11, 14, 17, 20, 23]
    now_hour = datetime.now().hour
    avail_hour = now_hour - 1  # 발표 후 ~40분 대기 여유
    best = slots[0]
    for s in slots:
        if s <= avail_hour:
            best = s
    return f'{best:02d}00'


# ─── 공휴일 ────────────────────────────────────────────────────────────────────

def fetch_holidays(year_months, key):
    """
    한국천문연구원 특일정보 → {date_str: name} dict
    year_months: [(2026, 2), (2026, 3), ...]
    """
    url = 'http://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo'
    results = {}

    for year, month in year_months:
        params = {
            'ServiceKey': key,
            'solYear': year,
            'solMonth': f'{month:02d}',
            'numOfRows': 50,
            '_type': 'json',
        }
        try:
            resp = requests.get(url, params=params, timeout=10)
            resp.raise_for_status()
            data = resp.json()

            header = data.get('response', {}).get('header', {})
            if header.get('resultCode') not in ('00', '0000', None):
                print(f'[EVE] ⚠️ 공휴일 API 오류 코드 ({year}-{month:02d}): {header}')
                continue

            items = data.get('response', {}).get('body', {}).get('items', {})
            if not items:
                continue

            item_list = items.get('item', [])
            if isinstance(item_list, dict):
                item_list = [item_list]

            for item in item_list:
                d = str(item.get('locdate', ''))
                if len(d) == 8:
                    date_str = f'{d[:4]}-{d[4:6]}-{d[6:]}'
                    results[date_str] = item.get('dateName', '공휴일')

        except Exception as e:
            print(f'[EVE] ⚠️ 공휴일 API 예외 ({year}-{month:02d}): {e}')

    return results


# ─── 날씨 ──────────────────────────────────────────────────────────────────────

def fetch_weather(base_date_str, base_time, key):
    """
    기상청 단기예보 → {date_str: {rain_prob, temperature}} dict
    base_date_str: 'YYYYMMDD'
    base_time: 'HH00'
    rain_prob: 0.0~1.0 (일 최대 강수확률)
    temperature: 일 평균기온 (°C)
    """
    url = 'http://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst'
    params = {
        'ServiceKey': key,
        'pageNo': 1,
        'numOfRows': 1000,
        'dataType': 'JSON',
        'base_date': base_date_str,
        'base_time': base_time,
        'nx': NX,
        'ny': NY,
    }
    results = {}
    try:
        resp = requests.get(url, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        header = data.get('response', {}).get('header', {})
        if header.get('resultCode') not in ('00', '0000', None):
            print(f'[EVE] ⚠️ 날씨 API 오류 코드: {header}')
            return results

        items = data.get('response', {}).get('body', {}).get('items', {})
        if not items:
            return results

        item_list = items.get('item', [])
        pop_by_date = {}   # date_str → max POP (%)
        tmp_by_date = {}   # date_str → [TMP values]

        for item in item_list:
            fcst_date = item.get('fcstDate', '')
            if len(fcst_date) != 8:
                continue
            date_str = f'{fcst_date[:4]}-{fcst_date[4:6]}-{fcst_date[6:]}'
            category = item.get('category', '')
            value = item.get('fcstValue', '0')

            if category == 'POP':
                try:
                    pop_val = int(value)
                    pop_by_date[date_str] = max(pop_by_date.get(date_str, 0), pop_val)
                except (ValueError, TypeError):
                    pass
            elif category == 'TMP':
                try:
                    tmp_by_date.setdefault(date_str, []).append(float(value))
                except (ValueError, TypeError):
                    pass

        all_dates = set(list(pop_by_date.keys()) + list(tmp_by_date.keys()))
        for date_str in all_dates:
            rain_prob = pop_by_date.get(date_str, 0) / 100.0
            temps = tmp_by_date.get(date_str, [])
            temperature = round(sum(temps) / len(temps), 1) if temps else None
            results[date_str] = {'rain_prob': rain_prob, 'temperature': temperature}

    except Exception as e:
        print(f'[EVE] ⚠️ 날씨 API 예외: {e}')

    return results


# ─── NEIS 학사일정 ─────────────────────────────────────────────────────────────

def get_seongnam_school_codes(key, max_schools=5):
    """성남시 고등학교 코드 동적 조회 → [SD_SCHUL_CODE, ...]"""
    url = 'https://open.neis.go.kr/hub/schoolInfo'
    params = {
        'KEY': key,
        'Type': 'json',
        'pIndex': 1,
        'pSize': max_schools,
        'ATPT_OFCDC_SC_CODE': 'J10',      # 경기도교육청
        'SCHUL_KND_SC_NM': '고등학교',
        'ORG_RDNMAAD': '경기도 성남시',    # 도로명주소 필터
    }
    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        school_info = data.get('schoolInfo')
        if not school_info or len(school_info) < 2:
            return []
        rows = school_info[1].get('row', [])
        codes = [row['SD_SCHUL_CODE'] for row in rows if 'SD_SCHUL_CODE' in row]
        print(f'[EVE] 성남 고등학교 코드 {len(codes)}개: {codes}')
        return codes
    except Exception as e:
        print(f'[EVE] ⚠️ 학교코드 조회 실패: {e}')
        return []


def fetch_neis_schedule(year_months, key):
    """
    교육부 NEIS 학사일정 → {date_str: event_name} dict
    성남시 고등학교 5곳 기준 (코드 동적 조회)
    """
    school_codes = get_seongnam_school_codes(key)
    if not school_codes:
        print('[EVE] ⚠️ 학교코드 없음 — NEIS 학사일정 수집 스킵')
        return {}

    # 정확한 서비스명: SchoolSchedule (scheduleInfo 아님)
    url = 'https://open.neis.go.kr/hub/SchoolSchedule'
    results = {}

    for school_code in school_codes:
        for year, month in year_months:
            params = {
                'KEY': key,
                'Type': 'json',
                'pIndex': 1,
                'pSize': 100,
                'ATPT_OFCDC_SC_CODE': 'J10',
                'SD_SCHUL_CODE': school_code,
                'AA_YMD': f'{year}{month:02d}',
            }
            try:
                resp = requests.get(url, params=params, timeout=10)
                resp.raise_for_status()
                data = resp.json()

                result_code = data.get('RESULT', {}).get('CODE', '')
                if result_code == 'INFO-200':
                    continue  # 해당 월 데이터 없음 (정상)

                schedule_data = data.get('SchoolSchedule')
                if not schedule_data or len(schedule_data) < 2:
                    continue

                rows = schedule_data[1].get('row', [])
                for item in rows:
                    event_date = item.get('AA_YMD', '')   # 'YYYYMMDD'
                    event_name = item.get('EVENT_NM', '').strip()
                    if len(event_date) == 8 and event_name:
                        date_str = f'{event_date[:4]}-{event_date[4:6]}-{event_date[6:]}'
                        if date_str in results and results[date_str] != event_name:
                            results[date_str] = f'{results[date_str]} | {event_name}'
                        else:
                            results[date_str] = event_name

            except Exception as e:
                print(f'[EVE] ⚠️ NEIS API 예외 ({school_code}, {year}-{month:02d}): {e}')

    return results


# ─── 축제 ──────────────────────────────────────────────────────────────────────

def fetch_festivals(key):
    """
    전국문화축제표준데이터 → 성남시 축제 {date_str: name} dict
    시작일~종료일 범위 전체 등록
    """
    url = 'http://api.data.go.kr/openapi/tn_pubr_public_cltur_fstvl_api'
    params = {
        'serviceKey': key,
        'pageNo': 1,
        'numOfRows': 100,
        'type': 'json',
        'signguNm': '성남시',
    }
    results = {}
    try:
        resp = requests.get(url, params=params, timeout=10)
        if 'text/html' in resp.headers.get('Content-Type', ''):
            # data.go.kr 동적 JS 챌린지 → 브라우저 없이 처리 불가
            # (API 키 미활성화 or 봇 차단) — 축제 데이터 수집 스킵
            print('[EVE] ⚠️ 축제 API: data.go.kr JS 챌린지 응답 — 키 활성화 대기 중이거나 Playwright 필요 (ska-005에서 처리)')
            return results
        resp = _follow_js_redirect(resp)
        resp.raise_for_status()
        data = resp.json()

        items = data.get('response', {}).get('body', {}).get('items', [])
        if not items:
            return results
        if isinstance(items, dict):
            items = [items]

        for item in items:
            start_str = item.get('fstvlStartDate', '')  # 'YYYYMMDD'
            end_str   = item.get('fstvlEndDate',   '')
            name      = item.get('fstvlNm', '').strip()
            if len(start_str) != 8 or not name:
                continue
            try:
                s = date_type(int(start_str[:4]), int(start_str[4:6]), int(start_str[6:]))
                e = date_type(int(end_str[:4]),   int(end_str[4:6]),   int(end_str[6:])) \
                    if len(end_str) == 8 else s
                cur = s
                while cur <= e:
                    ds = str(cur)
                    if ds not in results:
                        results[ds] = name
                    cur += timedelta(days=1)
            except Exception:
                date_str = f'{start_str[:4]}-{start_str[4:6]}-{start_str[6:]}'
                results[date_str] = name

    except Exception as e:
        print(f'[EVE] ⚠️ 축제 API 예외: {e}')

    return results


# ─── exam_score 계산 ──────────────────────────────────────────────────────────

def calc_exam_score(neis_event):
    """NEIS 이벤트명 기반 시험·방학 점수 (Prophet regressor 값)"""
    if not neis_event:
        return 0
    ev = neis_event
    score = 0
    if '수능' in ev or '대학수학능력' in ev:
        score += 10
    if '중간고사' in ev:
        score += 7
    if '기말고사' in ev:
        score += 7
    if '모의고사' in ev or '모의평가' in ev:
        score += 5
    if '방학' in ev:
        score -= 3
    if '개학' in ev or '입학' in ev:
        score += 2
    return score


# ─── 징검다리 연휴 (ska-012) ──────────────────────────────────────────────────

def calc_bridge_holiday_flags(con, range_start, range_end):
    """
    징검다리 연휴 감지 후 environment_factors.bridge_holiday_flag 업데이트.

    정의: 평일(월~금)인데 전날과 다음날이 모두 쉬는 날(공휴일 or 주말)인 경우.
      예) 화요일 공휴일 → 월요일(평일)의 전날=일요일(주말), 다음날=화요일(공휴일) → 징검다리
      예) 목요일 공휴일 → 금요일(평일)의 전날=목요일(공휴일), 다음날=토요일(주말) → 징검다리
    """
    buf_start = range_start - timedelta(days=1)
    buf_end   = range_end   + timedelta(days=1)

    # DB에서 공휴일 로드 + 주말 계산 → off_days set
    rows = con.execute("""
        SELECT date, holiday_flag
        FROM environment_factors
        WHERE date >= ? AND date <= ?
    """, (str(buf_start), str(buf_end))).fetchall()

    off_days = set()
    for r in rows:
        d = date_type.fromisoformat(str(r[0]))
        if r[1]:           # 공휴일
            off_days.add(d)
    # 주말 (DB 유무 무관)
    cur = buf_start
    while cur <= buf_end:
        if cur.weekday() >= 5:
            off_days.add(cur)
        cur += timedelta(days=1)

    # 각 날짜 bridge 여부 계산 + UPDATE
    updated = 0
    cur = range_start
    while cur <= range_end:
        if cur.weekday() < 5 and cur not in off_days:  # 평일 + 비공휴일
            is_bridge = (
                (cur - timedelta(days=1)) in off_days and
                (cur + timedelta(days=1)) in off_days
            )
        else:
            is_bridge = False
        con.execute(
            "UPDATE environment_factors SET bridge_holiday_flag = ? WHERE date = ?",
            (is_bridge, str(cur))
        )
        updated += 1
        cur += timedelta(days=1)

    bridge_cnt = con.execute("""
        SELECT COUNT(*) FROM environment_factors
        WHERE bridge_holiday_flag = true AND date >= ? AND date <= ?
    """, (str(range_start), str(range_end))).fetchone()[0]
    print(f'[EVE] 🗓️ 징검다리 연휴: {bridge_cnt}일 감지 (범위: {range_start}~{range_end})')
    return bridge_cnt


# ─── DuckDB 저장 ──────────────────────────────────────────────────────────────

def upsert_factor(con, date_str, holiday_map, weather_map, neis_map, festival_map):
    holiday_flag  = date_str in holiday_map
    holiday_name  = holiday_map.get(date_str)

    weather       = weather_map.get(date_str, {})
    rain_prob     = weather.get('rain_prob', 0.0)
    temperature   = weather.get('temperature')

    neis_event    = neis_map.get(date_str)
    exam_score    = calc_exam_score(neis_event)
    vacation_flag = bool(neis_event and '방학' in neis_event)
    exam_types    = neis_event

    festival_name = festival_map.get(date_str)
    festival_flag = bool(festival_name)

    factors_json = json.dumps({
        'holiday':     holiday_name,
        'rain_prob':   rain_prob,
        'temperature': temperature,
        'exam_score':  exam_score,
        'neis':        neis_event,
        'festival':    festival_name,
    }, ensure_ascii=False)

    con.execute("""
        INSERT INTO environment_factors
          (date, holiday_flag, holiday_name, rain_prob, temperature,
           exam_score, exam_types, vacation_flag, festival_flag, festival_name,
           factors_json, bridge_holiday_flag, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, current_timestamp)
        ON CONFLICT (date) DO UPDATE SET
          holiday_flag  = excluded.holiday_flag,
          holiday_name  = excluded.holiday_name,
          rain_prob     = excluded.rain_prob,
          temperature   = excluded.temperature,
          exam_score    = excluded.exam_score,
          exam_types    = excluded.exam_types,
          vacation_flag = excluded.vacation_flag,
          festival_flag = excluded.festival_flag,
          festival_name = excluded.festival_name,
          factors_json  = excluded.factors_json,
          updated_at    = excluded.updated_at
    """, (
        date_str, holiday_flag, holiday_name, rain_prob, temperature,
        exam_score, exam_types, vacation_flag, festival_flag, festival_name,
        factors_json,
    ))
    # bridge_holiday_flag는 calc_bridge_holiday_flags()에서 일괄 재계산


# ─── 메인 ─────────────────────────────────────────────────────────────────────

def run_eve(days_back=30, flags=None):
    if flags is None:
        flags = {'holiday', 'weather', 'neis', 'festival'}

    today = date_type.today()
    start = today - timedelta(days=days_back)
    end   = today + timedelta(days=7)   # 미래 7일 포함 (예측용)

    print(f'[EVE] 수집 기간: {start} ~ {end} (과거 {days_back}일 + 미래 7일)')
    print(f'[EVE] 플래그: {sorted(flags)}')

    secrets     = load_secrets()
    holiday_key = secrets.get('datagokr_holiday_key', '')
    weather_key = secrets.get('datagokr_weather_key', '')
    neis_key    = secrets.get('datagokr_neis_key', '')
    festival_key= secrets.get('datagokr_festival_key', '')

    year_months = get_year_months(start, end)

    holiday_map  = {}
    weather_map  = {}
    neis_map     = {}
    festival_map = {}

    if 'holiday' in flags:
        print(f'[EVE] 공휴일 수집 ({len(year_months)}개월)...')
        holiday_map = fetch_holidays(year_months, holiday_key)
        print(f'[EVE] 공휴일 {len(holiday_map)}개 발견: {list(holiday_map.items())[:5]}')

    if 'weather' in flags:
        base_date = today.strftime('%Y%m%d')
        base_time = get_base_time()
        print(f'[EVE] 날씨 수집 (기준: {base_date} {base_time})...')
        weather_map = fetch_weather(base_date, base_time, weather_key)
        print(f'[EVE] 날씨 {len(weather_map)}일치 수신')

    if 'neis' in flags:
        print('[EVE] NEIS 학사일정 수집...')
        neis_map = fetch_neis_schedule(year_months, neis_key)
        print(f'[EVE] 학사일정 {len(neis_map)}건 발견')

    if 'festival' in flags:
        print('[EVE] 성남시 축제 수집...')
        festival_map = fetch_festivals(festival_key)
        print(f'[EVE] 축제 {len(festival_map)}일치 발견')

    # 전체 날짜 집합: 수집 기간 전체 + API에서 발견된 날짜
    all_dates = set()
    cur = start
    while cur <= end:
        all_dates.add(str(cur))
        cur += timedelta(days=1)
    all_dates.update(holiday_map.keys())
    all_dates.update(weather_map.keys())
    all_dates.update(neis_map.keys())
    all_dates.update(festival_map.keys())

    con = duckdb.connect(DUCKDB_PATH)
    upserted = 0
    try:
        for date_str in sorted(all_dates):
            upsert_factor(con, date_str, holiday_map, weather_map, neis_map, festival_map)
            upserted += 1

        total       = con.execute("SELECT COUNT(*) FROM environment_factors").fetchone()[0]
        holiday_cnt = con.execute("SELECT COUNT(*) FROM environment_factors WHERE holiday_flag = true").fetchone()[0]
        weather_cnt = con.execute("SELECT COUNT(*) FROM environment_factors WHERE rain_prob > 0").fetchone()[0]

        print(f'[EVE] ✅ 완료: {upserted}행 upsert')
        print(f'[EVE] environment_factors 총 {total}행 / 공휴일 {holiday_cnt}일 / 강수기록 {weather_cnt}일')

        # 향후 7일 미리보기
        preview = con.execute("""
            SELECT date, holiday_flag, holiday_name, rain_prob, temperature,
                   exam_score, festival_flag, festival_name
            FROM environment_factors
            WHERE date >= current_date
            ORDER BY date
            LIMIT 7
        """).fetchall()

        print('[EVE] 향후 7일:')
        for p in preview:
            tags = []
            if p[1]:              tags.append(f'🎌{p[2]}')
            if p[3] > 0:          tags.append(f'🌧️{int(p[3]*100)}%')
            if p[4] is not None:  tags.append(f'{p[4]:.1f}°C')
            if p[5] != 0:         tags.append(f'📚{p[5]:+d}')
            if p[6]:              tags.append(f'🎪{p[7]}')
            print(f'  {p[0]}  {" ".join(tags) if tags else "-"}')

        # ska-012: 징검다리 연휴 플래그 일괄 재계산
        calc_bridge_holiday_flags(con, start, end)
    finally:
        con.close()
    return upserted


if __name__ == '__main__':
    days, flags = parse_args()
    run_eve(days, flags)
