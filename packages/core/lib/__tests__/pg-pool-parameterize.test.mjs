import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parameterize } = require('../pg-pool');

test('parameterize converts ordinary placeholders', () => {
  assert.equal(
    parameterize('SELECT * FROM posts WHERE status = ? AND category = ? LIMIT ?'),
    'SELECT * FROM posts WHERE status = $1 AND category = $2 LIMIT $3'
  );
});

test('parameterize preserves question marks inside SQL strings and comments', () => {
  assert.equal(
    parameterize("SELECT '?' AS literal, col FROM t WHERE id = ? -- keep ? in comment\nAND name = ?"),
    "SELECT '?' AS literal, col FROM t WHERE id = $1 -- keep ? in comment\nAND name = $2"
  );
});

test('parameterize preserves PostgreSQL JSONB existence operators', () => {
  assert.equal(
    parameterize("SELECT * FROM blog.posts WHERE metadata ? 'view_count' AND status = ?"),
    "SELECT * FROM blog.posts WHERE metadata ? 'view_count' AND status = $1"
  );
  assert.equal(
    parameterize("SELECT * FROM blog.posts WHERE metadata ?| array['a','b'] AND metadata ?& array['c']"),
    "SELECT * FROM blog.posts WHERE metadata ?| array['a','b'] AND metadata ?& array['c']"
  );
});

test('parameterize preserves JSONB existence operator with placeholder key', () => {
  assert.equal(
    parameterize('SELECT * FROM blog.posts WHERE metadata ? ? AND status = ?'),
    'SELECT * FROM blog.posts WHERE metadata ? $1 AND status = $2'
  );
});
