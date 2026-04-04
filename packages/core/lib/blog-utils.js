'use strict';

const fs = require('fs');
const path = require('path');

function weatherToContext(weather = {}, options = {}) {
  const { detailed = true } = options;
  const desc = weather.description || '맑음';
  const temp = weather.temperature != null ? `${weather.temperature}°C` : '';

  if (!detailed) {
    if (/비|rain/i.test(desc)) return `봄비가 내리는 ${temp}의 오늘`;
    if (/눈|snow/i.test(desc)) return `눈 내리는 겨울 ${temp}의 아침`;
    if (/흐림|cloud/i.test(desc)) return `흐린 ${temp}의 오늘`;
    if (weather.temperature < 10) return `쌀쌀한 ${temp}의 오늘`;
    if (weather.temperature > 28) return `무더운 ${temp}의 오늘`;
    return `쾌청한 ${desc} ${temp}의 오늘`;
  }

  const feels = weather.feels_like != null ? ` (체감 ${weather.feels_like}°C)` : '';
  const hum = weather.humidity != null ? `, 습도 ${weather.humidity}%` : '';

  if (/비|rain/i.test(desc)) return `봄비가 추적추적 내리는 ${temp}의 오늘${hum}`;
  if (/눈|snow/i.test(desc)) return `눈이 내리는 ${temp}의 겨울 아침${hum}`;
  if (/흐림|cloud/i.test(desc)) return `흐린 하늘 아래 ${temp}${feels}의 쌀쌀한 오늘${hum}`;
  if (weather.temperature < 10) return `기온 ${temp}${feels}의 쌀쌀한 오늘, 커피 한 잔이 생각나는`;
  if (weather.temperature > 28) return `${temp}의 무더운 오늘, 에어컨 바람이 시원한`;
  return `${desc} ${temp}${feels}의 쾌청한 오늘${hum}`;
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
