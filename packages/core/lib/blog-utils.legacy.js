'use strict';

const fs = require('fs');
const path = require('path');

function weatherToContext(weather = {}, options = {}) {
  const { detailed = true } = options;
  const desc = weather.description || '맑음';
  const tempNum = Number(weather.temperature);

  if (!detailed) {
    if (/비|rain/i.test(desc)) return '비 오는 날';
    if (/눈|snow/i.test(desc)) return '눈 오는 날';
    if (/흐림|cloud/i.test(desc)) return '흐린 날';
    if (Number.isFinite(tempNum) && tempNum < 10) return '쌀쌀한 날';
    if (Number.isFinite(tempNum) && tempNum > 28) return '더운 날';
    if (Number.isFinite(tempNum) && tempNum >= 18 && tempNum <= 24) return '화창한 날';
    return '맑은 날';
  }

  if (/비|rain/i.test(desc)) return '비 소리가 잔잔하게 들리는 날';
  if (/눈|snow/i.test(desc)) return '공기가 차분한 눈 오는 날';
  if (/흐림|cloud/i.test(desc)) return '흐린 날이라 실내에 더 오래 머물고 싶은 분위기';
  if (Number.isFinite(tempNum) && tempNum < 10) return '쌀쌀해서 따뜻한 커피가 먼저 떠오르는 날';
  if (Number.isFinite(tempNum) && tempNum > 28) return '더워서 시원한 실내가 반가운 날';
  if (Number.isFinite(tempNum) && tempNum >= 18 && tempNum <= 24) return '화창한 날이라 가볍게 걷기 좋은 분위기';
  return '맑아서 움직이기 좋은 분위기';
}

function estimateCost(usage) {
  if (!usage) return 0;
  return ((usage.prompt_tokens || 0) * 2.5 + (usage.completion_tokens || 0) * 10) / 1_000_000;
}

function loadPersonaGuide(filename) {
  const guidePath = path.join(__dirname, '..', '..', '..', 'bots', 'blog', 'context', filename);
  if (!fs.existsSync(guidePath)) return '';
  return fs.readFileSync(guidePath, 'utf8').trim();
}

module.exports = {
  weatherToContext,
  estimateCost,
  loadPersonaGuide,
};
