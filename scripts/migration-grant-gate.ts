#!/usr/bin/env tsx

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { analyzeMigrationGrantContract } from '../packages/core/lib/migration-grant-contract.ts';

function gitPaths(args: string[]): string[] {
  try {
    const output = execFileSync('git', args, { encoding: 'utf8' });
    return output.split('\n').map((item) => item.trim()).filter(Boolean);
  } catch (error: any) {
    throw new Error(`migration_grant_gate_git_failed:${error?.message || error}`);
  }
}

function isMigrationSource(filePath: string): boolean {
  return /(^|\/)migrations\/[^/]+\.(?:sql|[cm]?[jt]s)$/i.test(filePath);
}

type SourceViolation = { code: string; message: string };

function staticStringExpression(
  expression: ts.Expression,
): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return staticStringExpression(expression.expression);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringExpression(expression.left);
    const right = staticStringExpression(expression.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const interpolation = staticStringExpression(span.expression);
      if (interpolation === null) return null;
      value += interpolation + span.literal.text;
    }
    return value;
  }
  return null;
}

function postgresPoolAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  sourceFile.forEachChild((node) => {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && /(?:^|\/)pg-pool(?:\.[cm]?[jt]s)?$/.test(node.moduleSpecifier.text)
      && node.importClause) {
      if (node.importClause.name) aliases.add(node.importClause.name.text);
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) aliases.add(bindings.name.text);
    }
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = declaration.initializer;
      if (!ts.isCallExpression(initializer)
        || !ts.isIdentifier(initializer.expression)
        || initializer.expression.text !== 'require'
        || initializer.arguments.length !== 1
        || !ts.isStringLiteral(initializer.arguments[0])
        || !/(?:^|\/)pg-pool(?:\.[cm]?[jt]s)?$/.test(initializer.arguments[0].text)) continue;
      aliases.add(declaration.name.text);
    }
  });
  return aliases;
}

function postgresPoolMethod(call: ts.CallExpression, aliases: Set<string>): string | null {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression)
    && aliases.has(callee.expression.text)) {
    return callee.name.text;
  }
  if (ts.isElementAccessExpression(callee)
    && ts.isIdentifier(callee.expression)
    && aliases.has(callee.expression.text)
    && callee.argumentExpression) {
    return staticStringExpression(callee.argumentExpression);
  }
  return null;
}

function callsPostgresPoolAlias(call: ts.CallExpression, aliases: Set<string>): boolean {
  const callee = call.expression;
  return (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
    && ts.isIdentifier(callee.expression)
    && aliases.has(callee.expression.text);
}

export function migrationSqlSource(filePath: string, source: string): {
  sql: string;
  skipped: boolean;
  violations: SourceViolation[];
} {
  if (/\.sql$/i.test(filePath)) return { sql: source, skipped: false, violations: [] };
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.[cm]?js$/i.test(filePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const aliases = postgresPoolAliases(sourceFile);
  const explicitlyPostgres = /migration-grant-gate:\s*postgres(?:ql)?/i.test(source);
  const referencesPostgresPool = /(?:^|\/)pg-pool(?:\.[cm]?[jt]s)?['"]/m.test(source);
  if (!referencesPostgresPool && !explicitlyPostgres) {
    return { sql: '', skipped: true, violations: [] };
  }

  const sql: string[] = [];
  const violations: SourceViolation[] = [];
  let supportedSqlCalls = 0;

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)
      && node.initializer
      && ts.isIdentifier(node.initializer)
      && aliases.has(node.initializer.text)) {
      violations.push({
        code: 'postgres_driver_alias_escape_unverifiable',
        message: 'PostgreSQL migration pg-pool aliases may not be reassigned to an unverified SQL sink.',
      });
    }
    if (ts.isCallExpression(node)) {
      const method = postgresPoolMethod(node, aliases);
      const directPoolCall = callsPostgresPoolAlias(node, aliases);
      if (directPoolCall && method === null) {
        supportedSqlCalls += 1;
        violations.push({
          code: 'postgres_sql_sink_unverifiable',
          message: 'Dynamic pg-pool method calls require explicit SQL migration review.',
        });
      } else if (method === 'transaction') {
        supportedSqlCalls += 1;
        violations.push({
          code: 'postgres_transaction_callback_unverifiable',
          message: 'PostgreSQL migration transaction callbacks require explicit SQL migration review.',
        });
      } else if (method && /^(?:prepare|getPool|getClient)$/.test(method)) {
        supportedSqlCalls += 1;
        violations.push({
          code: 'postgres_sql_sink_unverifiable',
          message: `PostgreSQL migration ${method}() calls require explicit SQL migration review.`,
        });
      } else if (method && /^(?:run|query|get|queryReadonly)$/.test(method)) {
        supportedSqlCalls += 1;
        const sqlArgument = node.arguments[1];
        const value = sqlArgument ? staticStringExpression(sqlArgument) : null;
        if (value === null) {
          violations.push({
            code: 'postgres_sql_argument_not_static',
            message: 'PostgreSQL migration SQL must be a statically verifiable string expression.',
          });
        } else if (/\b(?:CREATE\s+(?:UNLOGGED\s+)?TABLE|GRANT|REVOKE)\b/i.test(value)) {
          sql.push(value);
        }
      } else if (directPoolCall && method) {
        supportedSqlCalls += 1;
        violations.push({
          code: 'postgres_sql_sink_unverifiable',
          message: `Unsupported PostgreSQL migration pg-pool method requires review: ${method}().`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (aliases.size === 0) {
    violations.push({
      code: 'postgres_driver_unrecognized',
      message: 'PostgreSQL migration does not use the statically supported pg-pool runner shape.',
    });
  } else if (supportedSqlCalls === 0 && /\b(?:CREATE\s+(?:UNLOGGED\s+)?TABLE|GRANT|REVOKE)\b/i.test(source)) {
    violations.push({
      code: 'postgres_sql_sink_unrecognized',
      message: 'PostgreSQL migration DDL is not passed through a statically supported pg-pool run/query call.',
    });
  }
  return { sql: sql.join(';\n'), skipped: false, violations };
}

function argValue(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || '';
}

function changedMigrationFiles(comparisonBase = ''): string[] {
  const committed = comparisonBase
    ? gitPaths(['diff', '--name-only', '--diff-filter=AM', `${comparisonBase}...HEAD`, '--'])
    : [];
  const working = gitPaths(['diff', '--name-only', '--diff-filter=AM', '--']);
  const staged = gitPaths(['diff', '--cached', '--name-only', '--diff-filter=AM', '--']);
  const untracked = gitPaths(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...committed, ...working, ...staged, ...untracked].filter(isMigrationSource))].sort();
}

function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const comparisonBase = argValue('base') || process.env.MIGRATION_GRANT_BASE || '';
  const files = (requested.length ? requested : changedMigrationFiles(comparisonBase)).map((filePath) => path.resolve(filePath));
  const results = files.map((filePath) => {
    if (!fs.existsSync(filePath)) {
      return {
        file: filePath,
        createdTables: [],
        violations: [{ code: 'migration_file_missing', message: `${filePath} does not exist.` }],
      };
    }
    const source = fs.readFileSync(filePath, 'utf8');
    const extracted = migrationSqlSource(filePath, source);
    const result = extracted.skipped
      ? { createdTables: [], violations: [] }
      : analyzeMigrationGrantContract(extracted.sql);
    return {
      file: filePath,
      skipped: extracted.skipped,
      createdTables: result.createdTables,
      violations: [...extracted.violations, ...result.violations],
    };
  });
  const violations = results.flatMap((result) => result.violations.map((violation) => ({
    file: result.file,
    ...violation,
  })));
  const report = {
    ok: violations.length === 0,
    mode: 'fail_closed',
    comparisonBase: comparisonBase || null,
    policy: 'hub_readonly:USAGE+SELECT',
    filesConsidered: results.length,
    filesChecked: results.filter((result) => !result.skipped).length,
    filesSkipped: results.filter((result) => result.skipped).length,
    tablesChecked: results.reduce((sum, result) => sum + result.createdTables.length, 0),
    violations,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error: any) {
    console.error(`[migration-grant-gate] ${error?.message || error}`);
    process.exitCode = 1;
  }
}
