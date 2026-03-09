"""
weather.py — 날씨 데이터 → 스터디카페 매출 영향 분류

⚠️ 별도 API 호출 없음.
eve.py가 매일 06:00에 기상청 API를 호출하여 environment_factors 테이블에 저장하고,
forecast.py가 load_future_env()로 이미 rain_prob / temperature 를 로드한다.
이 모듈은 그 env_info 데이터를 받아 매출 영향을 분류하는 로직만 담당한다.

사용법:
    from bots.ska.src.weather import classify_weather_impact
    impact, score, desc = classify_weather_impact(env_info)
    # env_info: {'rain_prob': 0.7, 'temperature': 8.0, ...}
"""


def classify_weather_impact(env_info):
    """
    env_info (environment_factors 행) → 스터디카페 매출 영향 분류

    스터디카페 특성:
      - 강수 / 폭염 / 한파 → 실내 수요 증가 → 매출 상승 가능
      - 쾌적한 맑은 날      → 외출 증가     → 방문 감소 가능

    반환:
        (impact: str, score: int, description: str)
        impact: 'positive' | 'neutral' | 'negative'
    """
    if not env_info:
        return 'neutral', 0, '날씨 데이터 없음'

    temp      = float(env_info.get('temperature', 20.0) or 20.0)
    rain_prob = float(env_info.get('rain_prob', 0.0) or 0.0)

    score   = 0
    reasons = []

    # 강수 → 실내 수요 증가
    if rain_prob > 0.6:
        score += 10
        reasons.append(f'강수 확률 {rain_prob*100:.0f}%')
    elif rain_prob > 0.3:
        score += 5
        reasons.append(f'강수 확률 {rain_prob*100:.0f}%')

    # 극한 기온 → 실내 선호
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

    # 쾌적한 날씨 → 외출 증가
    if 18 <= temp <= 25 and rain_prob < 0.2:
        score -= 5
        reasons.append(f'쾌적 ({temp:.0f}°C, 맑음)')

    reason_str = ' | '.join(reasons) if reasons else f'{temp:.0f}°C, 강수 {rain_prob*100:.0f}%'

    if score >= 8:
        return 'positive', score, f'실내 수요 증가 예상: {reason_str}'
    elif score <= -3:
        return 'negative', score, f'외출 증가로 수요 감소 가능: {reason_str}'
    else:
        return 'neutral', score, reason_str
