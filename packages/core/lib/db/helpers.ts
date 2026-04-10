// @ts-nocheck
'use strict';

function createSchemaDbHelpers(pgPool, schema) {
  return {
    query(sql, params = []) {
      return pgPool.query(schema, sql, params);
    },
    run(sql, params = []) {
      return pgPool.run(schema, sql, params);
    },
    get(sql, params = []) {
      return pgPool.get(schema, sql, params);
    },
  };
}

module.exports = {
  createSchemaDbHelpers,
};
