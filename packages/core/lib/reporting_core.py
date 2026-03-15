"""
packages/core/lib/reporting_core.py

Python 리포트/알림에서 공통으로 쓰는 최소 서식 helper.
"""


def build_report_section(title, lines=None):
    filtered = [line for line in (lines or []) if line]
    if not filtered and not title:
        return []
    block = []
    if title:
        block.append(title)
    block.extend(filtered)
    return block


def build_report(title, summary='', sections=None, footer=None):
    lines = [title] if title else []
    if summary:
        lines.extend(['', summary])

    for section in sections or []:
        block = build_report_section(section.get('title', ''), section.get('lines', []))
        if not block:
            continue
        if lines:
            lines.append('')
        lines.extend(block)

    footer_lines = [line for line in (footer or []) if line]
    if footer_lines:
        if lines:
            lines.append('')
        lines.extend(footer_lines)

    return '\n'.join(lines)
