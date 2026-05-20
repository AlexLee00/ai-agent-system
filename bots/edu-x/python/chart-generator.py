#!/usr/bin/env python3
"""
chart-generator.py — Edu-X 이미지 생성 (matplotlib)
호출: python3 chart-generator.py --type <bar|line> --data <json> --out <path>

차트 1 (bar):  Top 5 시총 막대 (market_data.json)
차트 2 (line): BTC 24h 가격 라인 (ohlcv_data.json)

출력: PNG 1200x600, /tmp/edux-images/{date}/{slot}_{type}.png
"""

import argparse
import json
import os
import sys
from datetime import datetime

try:
    import matplotlib
    matplotlib.use('Agg')  # GUI 없음
    import matplotlib.pyplot as plt
    import matplotlib.ticker as mticker
except ImportError:
    print("ERROR: matplotlib not installed. pip install matplotlib", file=sys.stderr)
    sys.exit(1)

# 한글 폰트 (Mac)
plt.rcParams['font.family'] = ['AppleGothic', 'Malgun Gothic', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False


def chart_bar_market_cap(data: dict, out_path: str):
    """Top 5 암호화폐 시총 막대 차트"""
    coins = data.get('coins', [])
    if not coins:
        coins = [
            {'symbol': 'BTC', 'market_cap': 1200},
            {'symbol': 'ETH', 'market_cap': 400},
            {'symbol': 'BNB', 'market_cap': 90},
            {'symbol': 'SOL', 'market_cap': 80},
            {'symbol': 'XRP', 'market_cap': 60},
        ]

    symbols = [c['symbol'] for c in coins[:5]]
    caps = [float(c.get('market_cap', 0)) for c in coins[:5]]
    colors = ['#F7931A', '#627EEA', '#F3BA2F', '#9945FF', '#00AAE4'][:len(symbols)]

    fig, ax = plt.subplots(figsize=(12, 6), facecolor='#1a1a2e')
    ax.set_facecolor('#16213e')
    bars = ax.bar(symbols, caps, color=colors, alpha=0.85, edgecolor='white', linewidth=0.5)

    for bar, cap in zip(bars, caps):
        label = f'${cap:.0f}B' if cap >= 1 else f'${cap * 1000:.0f}M'
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + max(caps) * 0.01,
                label, ha='center', va='bottom', color='white', fontsize=10, fontweight='bold')

    ax.set_title('Top 5 암호화폐 시가총액', color='white', fontsize=14, fontweight='bold', pad=15)
    ax.set_xlabel('종목', color='#aaaaaa', fontsize=11)
    ax.set_ylabel('시가총액 (십억 달러)', color='#aaaaaa', fontsize=11)
    ax.tick_params(colors='white')
    ax.spines['bottom'].set_color('#333355')
    ax.spines['left'].set_color('#333355')
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'${x:.0f}B'))
    plt.tight_layout()

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    plt.savefig(out_path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.close()
    print(f"saved: {out_path}")


def chart_line_btc_24h(data: dict, out_path: str):
    """BTC 24h 가격 라인 차트"""
    prices = data.get('prices', [])
    times = data.get('times', [])

    if not prices or not times:
        # 더미 데이터
        prices = [65000 + (i % 7 - 3) * 500 for i in range(24)]
        times = [f'{i:02d}:00' for i in range(24)]

    fig, ax = plt.subplots(figsize=(12, 6), facecolor='#1a1a2e')
    ax.set_facecolor('#16213e')

    min_p = min(prices)
    max_p = max(prices)
    color = '#00ff88' if prices[-1] >= prices[0] else '#ff4455'

    ax.plot(range(len(prices)), prices, color=color, linewidth=2, alpha=0.9)
    ax.fill_between(range(len(prices)), prices, min_p * 0.999,
                    color=color, alpha=0.15)

    step = max(1, len(times) // 8)
    ax.set_xticks(range(0, len(times), step))
    ax.set_xticklabels([times[i] for i in range(0, len(times), step)],
                       color='#aaaaaa', fontsize=9)

    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'${x:,.0f}'))
    ax.tick_params(colors='white')
    ax.spines['bottom'].set_color('#333355')
    ax.spines['left'].set_color('#333355')
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)

    change_pct = ((prices[-1] - prices[0]) / prices[0]) * 100 if prices[0] else 0
    sign = '+' if change_pct >= 0 else ''
    ax.set_title(f'BTC/USDT 24시간 ({sign}{change_pct:.1f}%)',
                 color='white', fontsize=14, fontweight='bold', pad=15)
    ax.set_xlabel('시간 (UTC)', color='#aaaaaa', fontsize=11)
    ax.set_ylabel('가격 (USD)', color='#aaaaaa', fontsize=11)
    plt.tight_layout()

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    plt.savefig(out_path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.close()
    print(f"saved: {out_path}")


def chart_bar_kospi_sector(data: dict, out_path: str):
    """코스피 섹터 ETF 막대 차트"""
    sectors = data.get('sectors', [
        {'name': '반도체', 'change': 1.2},
        {'name': '2차전지', 'change': -0.5},
        {'name': '바이오', 'change': 0.8},
        {'name': '금융', 'change': 0.3},
        {'name': '자동차', 'change': -0.2},
    ])
    names = [s['name'] for s in sectors[:6]]
    changes = [float(s.get('change', 0)) for s in sectors[:6]]
    colors = ['#00cc66' if c >= 0 else '#ff3355' for c in changes]

    fig, ax = plt.subplots(figsize=(12, 6), facecolor='#1a1a2e')
    ax.set_facecolor('#16213e')
    bars = ax.bar(names, changes, color=colors, alpha=0.85, edgecolor='white', linewidth=0.5)

    for bar, val in zip(bars, changes):
        ax.text(bar.get_x() + bar.get_width() / 2,
                bar.get_height() + (0.05 if val >= 0 else -0.08),
                f'{val:+.1f}%', ha='center', va='bottom' if val >= 0 else 'top',
                color='white', fontsize=10)

    ax.axhline(0, color='#555577', linewidth=0.8)
    ax.set_title('섹터 ETF 등락률', color='white', fontsize=14, fontweight='bold', pad=15)
    ax.tick_params(colors='white')
    ax.spines['bottom'].set_color('#333355')
    ax.spines['left'].set_color('#333355')
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:+.1f}%'))
    plt.tight_layout()

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    plt.savefig(out_path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.close()
    print(f"saved: {out_path}")


def chart_line_kis_index(data: dict, out_path: str):
    """KOSPI/KOSDAQ 6-session line chart"""
    series = data.get('series', {}) or {}
    times = series.get('times') or ['D-5', 'D-4', 'D-3', 'D-2', 'D-1', 'D']
    kospi = series.get('kospi') or [2870, 2888, 2894, 2910, 2904, 2920]
    kosdaq = series.get('kosdaq') or [862, 870, 875, 879, 881, 884]

    fig, ax1 = plt.subplots(figsize=(12, 6), facecolor='#1a1a2e')
    ax1.set_facecolor('#16213e')
    x = list(range(len(times)))
    ax1.plot(x, kospi, color='#00ccff', linewidth=2.5, marker='o', label='KOSPI')
    ax2 = ax1.twinx()
    ax2.plot(x, kosdaq, color='#ffaa33', linewidth=2.5, marker='o', label='KOSDAQ')

    ax1.set_xticks(x)
    ax1.set_xticklabels(times, color='#aaaaaa')
    ax1.tick_params(colors='white')
    ax2.tick_params(colors='white')
    ax1.spines['bottom'].set_color('#333355')
    ax1.spines['left'].set_color('#333355')
    ax2.spines['right'].set_color('#333355')
    ax1.spines['top'].set_visible(False)
    ax2.spines['top'].set_visible(False)
    ax1.set_title('국내 주요 지수 흐름', color='white', fontsize=14, fontweight='bold', pad=15)
    lines = ax1.get_lines() + ax2.get_lines()
    labels = [line.get_label() for line in lines]
    legend = ax1.legend(lines, labels, loc='upper left', frameon=False)
    for text in legend.get_texts():
        text.set_color('white')
    plt.tight_layout()

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    plt.savefig(out_path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.close()
    print(f"saved: {out_path}")


def chart_bar_mag7(data: dict, out_path: str):
    """Magnificent 7 daily change chart"""
    rows = data.get('mag7') or [
        {'symbol': 'NVDA', 'change_1d': 2.1},
        {'symbol': 'MSFT', 'change_1d': 0.8},
        {'symbol': 'AAPL', 'change_1d': -0.3},
        {'symbol': 'AMZN', 'change_1d': 0.5},
        {'symbol': 'META', 'change_1d': 1.1},
        {'symbol': 'GOOGL', 'change_1d': 0.6},
        {'symbol': 'TSLA', 'change_1d': -1.2},
    ]
    symbols = [r.get('symbol', '-') for r in rows[:7]]
    changes = [float(r.get('change_1d') or 0) for r in rows[:7]]
    colors = ['#00cc66' if value >= 0 else '#ff3355' for value in changes]

    fig, ax = plt.subplots(figsize=(12, 6), facecolor='#1a1a2e')
    ax.set_facecolor('#16213e')
    bars = ax.bar(symbols, changes, color=colors, alpha=0.85, edgecolor='white', linewidth=0.5)
    for bar, value in zip(bars, changes):
        ax.text(bar.get_x() + bar.get_width() / 2,
                bar.get_height() + (0.05 if value >= 0 else -0.08),
                f'{value:+.1f}%', ha='center', va='bottom' if value >= 0 else 'top',
                color='white', fontsize=10, fontweight='bold')
    ax.axhline(0, color='#555577', linewidth=0.8)
    ax.set_title('Magnificent 7 등락률', color='white', fontsize=14, fontweight='bold', pad=15)
    ax.tick_params(colors='white')
    ax.spines['bottom'].set_color('#333355')
    ax.spines['left'].set_color('#333355')
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:+.1f}%'))
    plt.tight_layout()

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    plt.savefig(out_path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.close()
    print(f"saved: {out_path}")


CHART_MAP = {
    'crypto_bar': chart_bar_market_cap,
    'crypto_line': chart_line_btc_24h,
    'kis_sector': chart_bar_kospi_sector,
    'kis_index_line': chart_line_kis_index,
    'overseas_bar': chart_bar_market_cap,
    'overseas_mag7': chart_bar_mag7,
}


def main():
    parser = argparse.ArgumentParser(description='Edu-X 차트 생성기')
    parser.add_argument('--type', required=True, choices=list(CHART_MAP.keys()),
                        help='차트 종류')
    parser.add_argument('--data', default='{}', help='JSON 데이터 문자열')
    parser.add_argument('--out', required=True, help='출력 PNG 경로')
    args = parser.parse_args()

    try:
        data = json.loads(args.data)
    except json.JSONDecodeError as e:
        print(f"ERROR: JSON 파싱 실패: {e}", file=sys.stderr)
        sys.exit(1)

    fn = CHART_MAP.get(args.type)
    if not fn:
        print(f"ERROR: 알 수 없는 차트 타입: {args.type}", file=sys.stderr)
        sys.exit(1)

    try:
        fn(data, args.out)
    except Exception as e:
        print(f"ERROR: 차트 생성 실패: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
