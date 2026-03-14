"""
packages/core/lib/health_core.py

전 팀 Python 헬스 리포트에서 공통으로 쓸 수 있는 최소 포맷 helper.
"""


def build_health_section(title, lines=None):
    filtered = [line for line in (lines or []) if line]
    if not filtered:
        return []
    if title:
        return [title, *filtered]
    return filtered


def build_health_decision_section(
    title='판단',
    recommended=False,
    level='hold',
    reasons=None,
    ok_text='현재는 관찰 유지',
):
    lines = [title]
    if recommended:
        badge = '🔧 즉시 검토' if level == 'high' else '🛠 검토 권장'
        lines.append(f'  {badge}')
    else:
        lines.append(f'  ✅ {ok_text}')
    for reason in (reasons or []):
        if reason:
            lines.append(f'  - {reason}')
    return lines


def build_health_report(title, subtitle='', sections=None, footer=None):
    lines = [title]
    if subtitle:
        lines.append(subtitle)

    for section in sections or []:
        block = build_health_section(section.get('title', ''), section.get('lines', []))
        if not block:
            continue
        if lines:
            lines.append('')
        lines.extend(block)

    footer_lines = [line for line in (footer or []) if line]
    if footer_lines:
        lines.append('')
        lines.extend(footer_lines)

    return '\n'.join(lines)
