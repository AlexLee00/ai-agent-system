"""
ska-005/014/015: 이브 크롤링 모듈

수능/모의고사: 공식 계산 기반 (Playwright 불필요)
  - 수능:         11월 둘째 목요일 (D-30~D-7 단계별 score)
  - 6/9월 평가원: 6/9월 첫째 목요일 (D-14~D-7 score)
  - 3/7/10월 학력평가: 각 월 둘째/셋째 목요일 (D-7 score)

큐넷 자격증: Playwright 크롤링 (ska-005)
  - 기술사 (scheType=01) / 기능장 (scheType=02) / 기사·산업기사 (scheType=03)
  - 필기시험 기간 추출 → D-14부터 시험기간 종료까지 score 누적

대학교 시험기간: Playwright 크롤링 (ska-014)
  - 가천대학교 글로벌캠퍼스 / 단국대학교 죽전캠퍼스
  - 중간고사·기말고사 기간 → D-14 prep + 시험기간 score

공무원 시험: 정적 캘린더 (ska-015)
  - 국가직·지방직 9급, 국가직 7급, 경찰·소방 공채
  - D-30~D-1 단계별 prep + 당일 score

타겟: PostgreSQL jay DB, ska 스키마 → exam_events 테이블

실행: bots/ska/venv/bin/python bots/ska/src/eve_crawl.py [--year=2026]
      --skip=university,civil  (항목 선택 제외)
launchd: 매주 일요일
"""
import sys
import os
import re
import psycopg2
from datetime import date as date_type, timedelta

PG_SKA = "dbname=jay options='-c search_path=ska,public'"

THURSDAY = 3  # weekday: 0=월 … 6=일


# ─── psycopg2 헬퍼 ──────────────────────────────────────────────────────────────

def _qry(con, sql, params=()):
    cur = con.cursor()
    cur.execute(sql, params)
    rows = cur.fetchall()
    cur.close()
    return rows

def _one(con, sql, params=()):
    cur = con.cursor()
    cur.execute(sql, params)
    row = cur.fetchone()
    cur.close()
    return row


# ─── 인자 파싱 ─────────────────────────────────────────────────────────────────

def parse_args():
    year = date_type.today().year
    skip = set()
    for arg in sys.argv[1:]:
        if arg.startswith('--year='):
            try:
                year = int(arg.split('=', 1)[1])
            except ValueError:
                print(f'[경고] --year 값 파싱 실패: {arg} — 현재 연도 사용')
        elif arg.startswith('--skip='):
            skip = set(arg.split('=', 1)[1].split(','))
    return year, skip


# ─── 날짜 계산 헬퍼 ────────────────────────────────────────────────────────────

def nth_weekday(year, month, weekday, n):
    """N번째 weekday 날짜 (1=첫째 …)"""
    d = date_type(year, month, 1)
    diff = (weekday - d.weekday()) % 7
    return d + timedelta(days=diff + (n - 1) * 7)


def date_range(start, end):
    """start~end 날짜 리스트"""
    dates = []
    cur = start
    while cur <= end:
        dates.append(cur)
        cur += timedelta(days=1)
    return dates


def days_before(target, n):
    """target 날짜 n일 전"""
    return target - timedelta(days=n)


# ─── 수능·모의고사 날짜 계산 ───────────────────────────────────────────────────

MOCK_SCHEDULE = {
    (3,  (THURSDAY, 2)): ('3월 학력평가', 4),
    (4,  (THURSDAY, 3)): ('4월 학력평가', 3),
    (6,  (THURSDAY, 1)): ('6월 평가원 모의평가', 6),
    (7,  (THURSDAY, 3)): ('7월 학력평가', 3),
    (9,  (THURSDAY, 1)): ('9월 평가원 모의평가', 6),
    (10, (THURSDAY, 3)): ('10월 학력평가', 3),
}


def calc_suneung_events(year):
    """
    수능 및 모의고사 이벤트 → [(date, exam_type, exam_name, score_weight)]
    D-30 ~ D-7: 단계별 prep score / D-7 ~ D-1: 집중 score
    """
    events = []

    suneung = nth_weekday(year, 11, THURSDAY, 2)
    score_map = [
        (days_before(suneung, 30), days_before(suneung, 22), 3,  'csat_prep_far'),
        (days_before(suneung, 21), days_before(suneung, 8),  5,  'csat_prep_mid'),
        (days_before(suneung, 7),  days_before(suneung, 1),  9,  'csat_prep_near'),
        (suneung,                  suneung,                  0,  'csat_day'),
    ]
    for start, end, sw, etype in score_map:
        for d in date_range(start, end):
            events.append((d, etype, f'{year}년 수능', sw))

    for (month, (wd, n)), (name, base_score) in MOCK_SCHEDULE.items():
        try:
            exam_day = nth_weekday(year, month, wd, n)
        except ValueError:
            continue

        for d in date_range(days_before(exam_day, 7), days_before(exam_day, 1)):
            events.append((d, 'mock_prep', name, round(base_score * 0.6)))
        events.append((exam_day, 'mock_day', name, base_score))

    return events


# ─── 큐넷 크롤링 ───────────────────────────────────────────────────────────────

QNET_TYPES = {
    '01': '기술사',
    '02': '기능장',
    '03': '기사·산업기사',
}

QNET_URL = 'https://www.q-net.or.kr/crf021.do?id=crf02101&gSite=Q&gId=&scheType={}'


def _parse_first_date(text):
    """텍스트에서 첫 번째 날짜 추출 → date or None"""
    m = re.search(r'(\d{4})\.(\d{2})\.(\d{2})', text)
    if m:
        return date_type(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def _parse_date_range(text):
    """'2026.01.30 - 2026.03.03 ...' → (start_date, end_date)"""
    dates = re.findall(r'(\d{4})\.(\d{2})\.(\d{2})', text)
    if not dates:
        return None, None
    start = date_type(int(dates[0][0]), int(dates[0][1]), int(dates[0][2]))
    end   = date_type(int(dates[-1][0]), int(dates[-1][1]), int(dates[-1][2]))
    return start, end


def crawl_qnet(year):
    """
    큐넷 3종 시험일정 크롤링 → 이벤트 리스트
    [(date, exam_type, exam_name, score_weight)]
    """
    from playwright.sync_api import sync_playwright

    all_events = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                       'AppleWebKit/537.36 (KHTML, like Gecko) '
                       'Chrome/131.0.0.0 Safari/537.36'
        )

        for stype, type_name in QNET_TYPES.items():
            url = QNET_URL.format(stype)
            try:
                page.goto(url, timeout=30000)
                page.wait_for_load_state('networkidle', timeout=15000)

                tables = page.query_selector_all('table')
                if not tables:
                    print(f'[CRAWL] ⚠️ {type_name}: 테이블 없음')
                    continue

                rows = tables[0].query_selector_all('tbody tr')
                print(f'[CRAWL] {type_name}: {len(rows)}회차 발견')

                for row in rows:
                    tds = row.query_selector_all('td')
                    if len(tds) < 7:
                        continue

                    round_text    = tds[0].inner_text().strip()
                    written_text  = tds[2].inner_text().strip()
                    practical_text= tds[6].inner_text().strip()

                    if str(year) not in round_text:
                        continue

                    w_start, w_end = _parse_date_range(written_text)
                    p_start, p_end = _parse_date_range(practical_text)

                    exam_label = f'{round_text.replace(chr(10)," ")} ({type_name})'

                    if w_start:
                        prep_start = days_before(w_start, 14)
                        prep_end   = days_before(w_start, 1)
                        for d in date_range(prep_start, prep_end):
                            all_events.append((d, 'qnet_written_prep', exam_label, 1))
                        for d in date_range(w_start, w_end):
                            all_events.append((d, 'qnet_written', exam_label, 2))

                    if p_start:
                        prep_start = days_before(p_start, 7)
                        prep_end   = days_before(p_start, 1)
                        for d in date_range(prep_start, prep_end):
                            all_events.append((d, 'qnet_practical_prep', exam_label, 1))
                        for d in date_range(p_start, p_end):
                            all_events.append((d, 'qnet_practical', exam_label, 1))

            except Exception as e:
                print(f'[CRAWL] ⚠️ {type_name} 크롤링 오류: {e}')

        browser.close()

    return all_events


# ─── ska-014: 대학교 시험기간 크롤링 ──────────────────────────────────────────

UNIV_KEYWORD_MAP = [
    ('중간고사', 'univ_midterm', 4),
    ('기말고사', 'univ_final', 4),
    ('중간 고사', 'univ_midterm', 4),
    ('기말 고사', 'univ_final', 4),
    ('중간시험', 'univ_midterm', 4),
    ('기말시험', 'univ_final', 4),
]

UNIV_PREP_DAYS = 14


def _parse_kor_date_range(text):
    """
    YYYY.MM.DD ~ YYYY.MM.DD / YYYY-MM-DD / YYYY년 MM월 DD일 파싱.
    첫·마지막 날짜를 start, end로 반환. 하나이면 start=end.
    """
    dates = re.findall(r'(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})', text)
    if not dates:
        m = re.search(r'(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일', text)
        if m:
            d = date_type(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            return d, d
        return None, None
    try:
        start = date_type(int(dates[0][0]), int(dates[0][1]), int(dates[0][2]))
        end   = date_type(int(dates[-1][0]), int(dates[-1][1]), int(dates[-1][2]))
        if end < start:
            end = start
        return start, end
    except ValueError:
        return None, None


def _classify_univ_event(text):
    """키워드로 시험 분류 → (exam_type, score_weight) or (None, 0). 성적 기간 제외."""
    if '성적' in text:
        return None, 0
    for keyword, etype, score in UNIV_KEYWORD_MAP:
        if keyword in text:
            return etype, score
    return None, 0


def _make_univ_events(exam_start, exam_end, exam_type, exam_name, score_weight):
    """D-14 prep(score//2) + 시험기간(score_weight) 이벤트 생성."""
    events = []
    prep_type = exam_type + '_prep'
    prep_score = max(1, score_weight // 2)
    for d in date_range(days_before(exam_start, UNIV_PREP_DAYS),
                        days_before(exam_start, 1)):
        events.append((d, prep_type, exam_name, prep_score))
    for d in date_range(exam_start, exam_end):
        events.append((d, exam_type, exam_name, score_weight))
    return events


def _crawl_gachon(year, page):
    """
    가천대학교 학사일정:
      URL: https://www.gachon.ac.kr/kor/1075/subview.do?year=YYYY&month=N
      형식: MM.DD ~ MM.DD\t이벤트명  (연도 URL에서 추론)
    3~12월 순회하여 중간고사·기말고사 수집.
    """
    events = []
    found = set()

    for month in range(3, 13):
        url = (f'https://www.gachon.ac.kr/kor/1075/subview.do'
               f'?year={year}&month={month}')
        try:
            page.goto(url, timeout=20000)
            page.wait_for_load_state('networkidle', timeout=15000)
            text = page.inner_text('body')
        except Exception as e:
            print(f'[CRAWL] 가천대학교 {month}월 오류: {e}')
            continue

        for line in text.split('\n'):
            line = line.strip()
            if '\t' not in line:
                continue

            parts = line.split('\t')
            date_part = parts[0].strip()
            event_text = parts[-1].strip()

            exam_type, score = _classify_univ_event(event_text)
            if not exam_type:
                continue

            date_nums = re.findall(r'(\d{1,2})\.(\d{2})', date_part)
            if not date_nums:
                continue
            try:
                start = date_type(year, int(date_nums[0][0]), int(date_nums[0][1]))
                end   = date_type(year, int(date_nums[-1][0]), int(date_nums[-1][1]))
                if end < start:
                    end = start
            except ValueError:
                continue

            key = (start, end, exam_type)
            if key in found:
                continue
            found.add(key)

            label = '중간고사' if 'midterm' in exam_type else '기말고사'
            exam_name = f'{year}년 가천대학교 {label}'
            batch = _make_univ_events(start, end, exam_type, exam_name, score)
            events += batch
            print(f'[CRAWL] 가천대학교: {exam_name} {start}~{end} → {len(batch)}건')

    print(f'[CRAWL] 가천대학교 합계: {len(events)}건')
    return events


def _crawl_dankook(year, page):
    """
    단국대학교 죽전 학사일정:
      URL: https://www.dankook.ac.kr/web/kor/-2014-
      형식: li 요소 → YYYY.MM.DD ~ YYYY.MM.DD 이벤트명
    올해·내년 데이터 모두 수집.
    """
    events = []
    found = set()

    url = 'https://www.dankook.ac.kr/web/kor/-2014-'
    try:
        page.goto(url, timeout=20000)
        page.wait_for_load_state('networkidle', timeout=15000)
    except Exception as e:
        print(f'[CRAWL] 단국대학교 죽전 로드 오류: {e}')
        return []

    lis = page.query_selector_all('li')
    for li in lis:
        text = li.inner_text().strip().replace('\n', ' ')
        if not text or len(text) > 200:
            continue

        exam_type, score = _classify_univ_event(text)
        if not exam_type:
            continue

        start, end = _parse_kor_date_range(text)
        if not start or start.year not in (year, year + 1):
            continue

        key = (start, end, exam_type)
        if key in found:
            continue
        found.add(key)

        label = '중간고사' if 'midterm' in exam_type else '기말고사'
        exam_name = f'{start.year}년 단국대학교 죽전 {label}'
        batch = _make_univ_events(start, end, exam_type, exam_name, score)
        events += batch
        print(f'[CRAWL] 단국대학교 죽전: {exam_name} {start}~{end} → {len(batch)}건')

    print(f'[CRAWL] 단국대학교 죽전 합계: {len(events)}건')
    return events


def crawl_university_exams(year):
    """
    ska-014: 가천대·단국대 죽전 학사일정 크롤링 → exam_events 포맷.
    크롤링 실패 시 0건 반환.
    """
    from playwright.sync_api import sync_playwright

    all_events = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(
                user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                           'AppleWebKit/537.36 (KHTML, like Gecko) '
                           'Chrome/131.0.0.0 Safari/537.36'
            )
            all_events += _crawl_gachon(year, page)
            all_events += _crawl_dankook(year, page)
            browser.close()
    except Exception as e:
        print(f'[CRAWL] ⚠️ 대학교 크롤링 전체 오류: {e}')

    return all_events


# ─── ska-015: 공무원 시험 정적 캘린더 ─────────────────────────────────────────

CIVIL_EXAM_SCHEDULE = {
    2025: [
        ('2025-04-05', '2025년 국가직 9급 공채 필기', 5),
        ('2025-06-21', '2025년 지방직 9급 공채 필기', 5),
        ('2025-09-06', '2025년 국가직 7급 공채 필기', 4),
        ('2025-05-17', '2025년 경찰공채 1차 필기', 3),
        ('2025-04-26', '2025년 소방공채 1차 필기', 3),
    ],
    2026: [
        # ⚠️ 예상 일정 — 공고 확정 후 갱신 필요
        ('2026-04-11', '2026년 국가직 9급 공채 필기', 5),
        ('2026-06-20', '2026년 지방직 9급 공채 필기', 5),
        ('2026-08-29', '2026년 국가직 7급 공채 필기', 4),
        ('2026-05-16', '2026년 경찰공채 1차 필기', 3),
        ('2026-04-25', '2026년 소방공채 1차 필기', 3),
    ],
}

CIVIL_PREP_BANDS = [
    (30, 22, 2, 'civil_exam_prep_far'),
    (21,  8, 3, 'civil_exam_prep_mid'),
    ( 7,  1, 5, 'civil_exam_prep_near'),
]


def calc_civil_exam_events(year=None):
    """
    ska-015: 공무원 시험 정적 캘린더 → exam_events 포맷 리스트.
    올해 + 내년 데이터를 함께 등록 (연말~내년 초 예측용).
    """
    if year is None:
        year = date_type.today().year

    events = []
    for yr in (year, year + 1):
        schedule = CIVIL_EXAM_SCHEDULE.get(yr, [])
        if not schedule:
            print(f'[CIVIL] {yr}년 공무원 시험 일정 없음 (CIVIL_EXAM_SCHEDULE 추가 필요)')
            continue

        for date_str, exam_name, score_weight in schedule:
            try:
                exam_date = date_type.fromisoformat(date_str)
            except ValueError:
                print(f'[CIVIL] ⚠️ 날짜 파싱 오류: {date_str}')
                continue

            for days_from, days_to, score, etype in CIVIL_PREP_BANDS:
                for d in date_range(days_before(exam_date, days_from),
                                    days_before(exam_date, days_to)):
                    events.append((d, etype, exam_name, score))

            events.append((exam_date, 'civil_exam', exam_name, score_weight))
            print(f'[CIVIL] {exam_name} ({exam_date}) 등록')

    return events


# ─── PostgreSQL 저장 ──────────────────────────────────────────────────────────

def upsert_events(con, events, source='calc'):
    """exam_events 테이블에 UPSERT (UNIQUE: date + exam_type + exam_name)"""
    inserted = 0
    cur = con.cursor()
    for d, exam_type, exam_name, score_weight in events:
        cur.execute("""
            INSERT INTO exam_events (date, exam_type, exam_name, score_weight, source)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (date, exam_type, exam_name) DO UPDATE SET
              score_weight = EXCLUDED.score_weight,
              source = EXCLUDED.source
        """, (str(d), exam_type, exam_name, score_weight, source))
        inserted += 1
    cur.close()
    return inserted  # caller commits


def show_upcoming(con, days=14):
    """향후 N일 시험 일정 미리보기"""
    rows = _qry(con, f"""
        SELECT date, SUM(score_weight) as total_score,
               string_agg(DISTINCT exam_name, ' / ') as names
        FROM exam_events
        WHERE date >= current_date AND date <= current_date + INTERVAL '{int(days)} days'
        GROUP BY date ORDER BY date
    """)
    return rows


# ─── 메인 ─────────────────────────────────────────────────────────────────────

def run_crawl(year=None, skip=None):
    if year is None:
        year = date_type.today().year
    if skip is None:
        skip = set()

    print(f'[CRAWL] {year}년 이벤트 수집 시작 (skip={skip or "없음"})')

    con = psycopg2.connect(PG_SKA)
    total = 0

    # ── 1. 수능·모의고사 (계산 기반) ────────────────────────────────────────────
    if 'suneung' not in skip:
        print('[CRAWL] 수능·모의고사 날짜 계산...')
        suneung_events = calc_suneung_events(year) + calc_suneung_events(year + 1)
        print(f'[CRAWL] 수능·모의고사: {len(suneung_events)}건')
        total += upsert_events(con, suneung_events, source='calc')
        con.commit()

    # ── 2. 큐넷 자격증 (Playwright 크롤링) ──────────────────────────────────────
    if 'qnet' not in skip:
        print('[CRAWL] 큐넷 시험일정 크롤링...')
        qnet_events = crawl_qnet(year)
        print(f'[CRAWL] 큐넷: {len(qnet_events)}건')
        total += upsert_events(con, qnet_events, source='crawl')
        con.commit()

    # ── 3. ska-014: 대학교 시험기간 (Playwright 크롤링) ─────────────────────────
    if 'university' not in skip:
        print('[CRAWL] 대학교 시험기간 크롤링 (가천대·단국대 죽전)...')
        univ_events = crawl_university_exams(year)
        print(f'[CRAWL] 대학교: {len(univ_events)}건')
        total += upsert_events(con, univ_events, source='crawl')
        con.commit()

    # ── 4. ska-015: 공무원 시험 (정적 캘린더) ───────────────────────────────────
    if 'civil' not in skip:
        print('[CRAWL] 공무원 시험 정적 캘린더 등록...')
        civil_events = calc_civil_exam_events(year)
        print(f'[CRAWL] 공무원: {len(civil_events)}건')
        total += upsert_events(con, civil_events, source='static')
        con.commit()

    # ── 집계 ────────────────────────────────────────────────────────────────────
    row_count  = _one(con, "SELECT COUNT(*) FROM exam_events")[0]
    date_count = _one(con, "SELECT COUNT(DISTINCT date) FROM exam_events")[0]
    src_counts = _qry(con, "SELECT source, COUNT(*) FROM exam_events GROUP BY source ORDER BY source")

    print(f'[CRAWL] ✅ 완료: {total}건 upsert → exam_events 총 {row_count}행 ({date_count}일)')
    print('[CRAWL] source별 건수:')
    for src, cnt in src_counts:
        print(f'  {src or "null":10s}: {cnt}건')

    # 향후 30일 미리보기
    upcoming = show_upcoming(con, 30)
    if upcoming:
        print('[CRAWL] 향후 30일 이벤트:')
        for row in upcoming:
            print(f'  {row[0]}  점수합={row[1]:>3}  {row[2][:60]}')

    con.close()
    return total


if __name__ == '__main__':
    year, skip = parse_args()
    run_crawl(year, skip)
