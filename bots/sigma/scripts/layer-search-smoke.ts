#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildLayerRoute,
  classifyLayerIntent,
  coordsMatchFilters,
} from '../vault/layer-router.ts';
import { searchVault } from '../vault/vault-search.ts';

function mockDeps({ coordColumns = true } = {}) {
  const calls = [];
  return {
    calls,
    embeddingFactory: async () => ({ embedding: [0.1, 0.2, 0.3], dim: 3 }),
    queryReadonly: async (schema, sql, params = []) => {
      calls.push({ schema, sql, params });
      assert.equal(schema, 'sigma');
      assert.match(String(sql).trim(), /^SELECT/i);
      assert.equal(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(sql), false);
      if (String(sql).includes('information_schema.columns')) {
        return coordColumns
          ? [
            { column_name: 'abstraction_level' },
            { column_name: 'time_stage' },
            { column_name: 'validation_state' },
            { column_name: 'prediction_state' },
            { column_name: 'prediction_horizon' },
          ]
          : [];
      }
      return [
        {
          id: 'v1',
          title: '시장 전망',
          source: 'sigma',
          content_preview: '다음 주 시장 전망',
          meta: { libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'observed', prediction_state: 'forward' } },
          similarity: 0.91,
          abstraction_level: 'L0',
          time_stage: 'raw',
          validation_state: 'observed',
          prediction_state: 'forward',
        },
        {
          id: 'v2',
          title: '원리 문서',
          source: 'sigma',
          content_preview: '패턴 원리',
          meta: { libraryCoords: { abstraction_level: 'L2', time_stage: 'digest', validation_state: 'validated', prediction_state: 'none' } },
          similarity: 0.89,
          abstraction_level: 'L2',
          time_stage: 'digest',
          validation_state: 'validated',
          prediction_state: 'none',
        },
      ];
    },
  };
}

async function main() {
  assert.equal(classifyLayerIntent('다음 주 전망을 보여줘').intent, 'prediction');
  assert.equal(classifyLayerIntent('검증된 전략 반영 근거').intent, 'strategy');
  const route = buildLayerRoute('원리를 설명해줘');
  assert.equal(route.intent, 'principle');
  assert.equal(coordsMatchFilters({ abstraction_level: 'L2', time_stage: 'digest' }, route.coordFilters), true);
  assert.equal(coordsMatchFilters({}, buildLayerRoute('최근 자료').coordFilters), true, 'NULL coords should default to L0/raw for recent');
  assert.equal(coordsMatchFilters({}, buildLayerRoute('근거 원문').coordFilters), true, 'NULL coords should default to L0/raw for evidence');
  assert.equal(coordsMatchFilters({}, buildLayerRoute('원리 설명').coordFilters), false, 'NULL coords must not match principle');
  assert.equal(coordsMatchFilters({}, buildLayerRoute('다음 주 전망').coordFilters), false, 'NULL coords must not match prediction');
  assert.equal(coordsMatchFilters({}, buildLayerRoute('검증된 전략 반영').coordFilters), false, 'NULL coords must not match strategy');

  const offDeps = mockDeps();
  const off = await searchVault('다음 주 전망', {
    topK: 2,
    layerSearchEnabled: false,
    deps: offDeps,
  });
  assert.equal(off.ok, true);
  assert.equal(off.routing, undefined);
  assert.equal(off.results.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(off.results[0], 'libraryCoords'), false);
  assert.equal(offDeps.calls.some((call) => String(call.sql).includes('information_schema.columns')), false);

  const onDeps = mockDeps();
  const on = await searchVault('다음 주 전망', {
    topK: 2,
    layerSearchEnabled: true,
    includeRoutingDebug: true,
    deps: onDeps,
  });
  assert.equal(on.ok, true);
  assert.equal(on.routing.intent, 'prediction');
  assert.equal(on.results.length, 1);
  assert.equal(on.results[0].id, 'v1');
  assert.equal(onDeps.calls.some((call) => String(call.sql).includes('information_schema.columns')), true);

  const nullDeps = mockDeps();
  const recent = await searchVault('최근 자료', {
    topK: 2,
    layerSearchEnabled: true,
    intent: 'recent',
    includeRoutingDebug: true,
    deps: {
      ...nullDeps,
      queryReadonly: async (schema, sql, params = []) => {
        nullDeps.calls.push({ schema, sql, params });
        if (String(sql).includes('information_schema.columns')) {
          return [
            { column_name: 'abstraction_level' },
            { column_name: 'time_stage' },
            { column_name: 'validation_state' },
            { column_name: 'prediction_state' },
            { column_name: 'prediction_horizon' },
          ];
        }
        return [
          {
            id: 'null-raw',
            title: '좌표 미적용 raw',
            source: 'sigma',
            content_preview: '최근 자료',
            meta: {},
            similarity: 0.92,
            abstraction_level: null,
            time_stage: null,
            validation_state: null,
            prediction_state: null,
          },
        ];
      },
    },
  });
  assert.equal(recent.ok, true);
  assert.equal(recent.results[0].id, 'null-raw');

  const fallbackDeps = mockDeps({ coordColumns: false });
  const fallback = await searchVault('원리', {
    topK: 2,
    layerSearchEnabled: true,
    intent: 'principle',
    includeRoutingDebug: true,
    deps: fallbackDeps,
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.routing.fallback, 'meta.libraryCoords');
  assert.equal(fallback.results[0].id, 'v2');

  console.log(JSON.stringify({ ok: true, smoke: 'layer-search', checks: 20 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
