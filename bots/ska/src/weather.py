"""
weather.py — 실시간 날씨 조회 + 스터디카페 매출 영향 분류

forecast.py LLM 컨텍스트 강화용.
eve.py가 기상청 데이터를 매일 06:00에 수집하지만,
이 모듈은 예측 실행 시점의 실시간 날씨를 추가로 조회한다.

필요 환경변수 (둘 중 하나):
  OPENWEATHERMAP_API_KEY  — openweathermap.org 무료 API 키 (일 1,000회)
  KMA_API_KEY             — data.go.kr 기상청 단기예보 API 키 (일 500회)

사용법:
    from bots.ska.src.weather import get_current_weather, classify_weather_impact
    weather = get_current_weather()
    if weather:
        impact, score, desc = classify_weather_impact(weather)
        print(f'날씨 영향: {impact} ({score:+d}) — {desc}')
"""

import os
import json
import urllib.request
import urllib.parse
from datetime import datetime

# 성남시 분당구 좌표 (eve.py와 동일)
DEFAULT_LAT = 37.3595
DEFAULT_LON = 127.1052

# 기상청 격자 좌표 (eve.py와 동일: NX=62, NY=122)
KMA_NX = 62
KMA_NY = 122


def _http_get(url, timeout=10):
    """단순 GET 요청 — JSON 반환, 실패 시 None"""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception:
        return None


def get_weather_owm(lat=DEFAULT_LAT, lon=DEFAULT_LON):
    """
    OpenWeatherMap 현재 날씨 조회 (OPENWEATHERMAP_API_KEY 환경변수 필요)

    반환:
        {'source': 'owm', 'temperature': float, 'feels_like': float,
         'humidity': int, 'description': str, 'rain_1h': float,
         'snow_1h': float, 'wind_speed': float, 'rain_prob': float}
    """
    api_key = os.environ.get('OPENWEATHERMAP_API_KEY', '')
    if not api_key:
        return None

    url = (
        f'https://api.openweathermap.org/data/2.5/weather'
        f'?lat={lat}&lon={lon}&appid={api_key}&units=metric&lang=kr'
    )
    data = _http_get(url)
    if not data or 'main' not in data:
        return None

    return {
        'source':      'owm',
        'temperature': data['main']['temp'],
        'feels_like':  data['main']['feels_like'],
        'humidity':    data['main']['humidity'],
        'description': data['weather'][0]['description'],
        'rain_1h':     data.get('rain', {}).get('1h', 0.0),
        'snow_1h':     data.get('snow', {}).get('1h', 0.0),
        'wind_speed':  data['wind']['speed'],
        'rain_prob':   1.0 if data.get('rain', {}).get('1h', 0) > 0 else 0.0,
    }


def get_weather_kma(nx=KMA_NX, ny=KMA_NY):
    """
    기상청 단기예보 조회 (KMA_API_KEY 환경변수 필요)

    반환:
        {'source': 'kma', 'temperature': float, 'rain_prob': float,
         'precip_type': int, 'sky': int}
    """
    api_key = os.environ.get('KMA_API_KEY', '')
    if not api_key:
        return None

    now = datetime.now()
    base_date = now.strftime('%Y%m%d')
    # 기상청 3시간 단위 발표 시각
    base_time = f'{(now.hour // 3) * 3:02d}00'

    params = urllib.parse.urlencode({
        'serviceKey': api_key,
        'numOfRows':  50,
        'pageNo':     1,
        'dataType':   'JSON',
        'base_date':  base_date,
        'base_time':  base_time,
        'nx':         nx,
        'ny':         ny,
    })
    url = (
        'http://apis.data.go.kr/1360000/VilageFcstInfoService_2.0'
        f'/getVilageFcst?{params}'
    )
    data = _http_get(url)
    if not data:
        return None

    items = (
        data.get('response', {})
            .get('body', {})
            .get('items', {})
            .get('item', [])
    )
    result = {'source': 'kma'}
    for item in items:
        cat, val = item.get('category'), item.get('fcstValue')
        try:
            if   cat == 'TMP':  result['temperature'] = float(val)
            elif cat == 'POP':  result['rain_prob']    = float(val) / 100.0
            elif cat == 'PTY':  result['precip_type']  = int(val)
            elif cat == 'SKY':  result['sky']          = int(val)
        except (TypeError, ValueError):
            pass

    return result if len(result) > 1 else None


def get_current_weather():
    """
    OWM 우선 → KMA 폴백으로 현재 날씨 조회.
    두 API 키 모두 없으면 None 반환.
    """
    return get_weather_owm() or get_weather_kma() or None


def classify_weather_impact(weather):
    """
    날씨 데이터 → 스터디카페 매출 영향 분류

    스터디카페 특성:
      - 비/눈/강풍 → 외출 감소 → 실내 수요 증가 → 매출 상승 가능
      - 폭염/한파 → 실내 선호 → 매출 상승 가능
      - 쾌적한 맑은 날 → 외출 증가 → 방문 고객 감소 가능

    반환:
        (impact: str, score: int, description: str)
        impact: 'positive' | 'neutral' | 'negative'
        score: 양수 = 매출 상승 요인, 음수 = 하락 요인
    """
    if not weather:
        return 'neutral', 0, '날씨 데이터 없음'

    temp         = weather.get('temperature', 20.0)
    rain_prob    = weather.get('rain_prob', 0.0)
    precip_type  = weather.get('precip_type', 0)   # 0:없음 1:비 2:비/눈 3:눈
    rain_1h      = weather.get('rain_1h', 0.0)
    description  = weather.get('description', '')

    score   = 0
    reasons = []

    # ── 강수 → 실내 수요 증가 ──
    if precip_type > 0 or rain_1h > 0 or rain_prob > 0.6:
        score += 10
        reasons.append(f'강수 (확률 {rain_prob*100:.0f}%)')

    # ── 극한 기온 → 실내 선호 ──
    if temp > 33:
        score += 15
        reasons.append(f'폭염 ({temp:.0f}°C)')
    elif temp > 30:
        score += 8
        reasons.append(f'고온 ({temp:.0f}°C)')
    elif temp < -5:
        score += 15
        reasons.append(f'혹한 ({temp:.0f}°C)')
    elif temp < 0:
        score += 8
        reasons.append(f'한파 ({temp:.0f}°C)')

    # ── 쾌적한 날씨 → 외출 증가 ──
    if 18 <= temp <= 25 and rain_prob < 0.2:
        score -= 5
        reasons.append(f'쾌적 ({temp:.0f}°C, 맑음)')

    desc_str  = description or ('강수' if score > 0 else '맑음')
    reason_str = ' | '.join(reasons) if reasons else desc_str

    if score >= 8:
        return 'positive', score, f'실내 수요 증가 예상: {reason_str}'
    elif score <= -3:
        return 'negative', score, f'외출 증가로 수요 감소 가능: {reason_str}'
    else:
        return 'neutral', score, reason_str or '날씨 영향 중립'
