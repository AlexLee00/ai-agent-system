export const HUB_READONLY_GRANT_POLICY = Object.freeze({
  role: 'hub_readonly',
  schemas: Object.freeze([
    'agent',
    'blog',
    'claude',
    'hub',
    'investment',
    'public',
    'reservation',
    'sigma',
    'ska',
  ]),
  schemaPrivileges: Object.freeze(['USAGE']),
  relationPrivileges: Object.freeze(['SELECT']),
});

type GrantViolation = {
  code: string;
  relation?: string;
  schema?: string;
  message: string;
};

type PrivilegeState = {
  schemaUsage: Set<string>;
  tableSelect: Set<string>;
  forbiddenGrantOptions: Set<string>;
  unsafeGrantRecipients: Set<string>;
  forbiddenPrivilegeGrants: Set<string>;
  publicPrivilegeGrants: Set<string>;
};

type CreatedTable = {
  schema: string | null;
  table: string;
  relation: string;
};

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED_IDENTIFIER = new RegExp(`^(${IDENTIFIER})\\s*\\.\\s*(${IDENTIFIER})$`);

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed.toLowerCase();
}

function scrubSql(source: string): { sql: string; lexicalErrors: string[]; dynamicSqlErrors: string[] } {
  let output = '';
  const lexicalErrors: string[] = [];
  const dynamicSqlErrors: string[] = [];
  for (let index = 0; index < source.length;) {
    if (source.startsWith('--', index)) {
      const end = source.indexOf('\n', index + 2);
      if (end === -1) {
        output += ' '.repeat(source.length - index);
        break;
      }
      output += ' '.repeat(end - index) + '\n';
      index = end + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith('/*', cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith('*/', cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      output += source.slice(index, cursor).replace(/[^\n\r]/g, ' ');
      if (depth > 0) lexicalErrors.push('unterminated_block_comment');
      index = cursor;
      continue;
    }
    if (source[index] === "'") {
      const escapeString = /[eE]/.test(source[index - 1] || '')
        && !/[A-Za-z0-9_$]/.test(source[index - 2] || '');
      let cursor = index + 1;
      let closed = false;
      while (cursor < source.length) {
        if (escapeString && source[cursor] === '\\') {
          cursor += Math.min(2, source.length - cursor);
        } else if (source[cursor] === "'" && source[cursor + 1] === "'") {
          cursor += 2;
        } else if (source[cursor] === "'") {
          cursor += 1;
          closed = true;
          break;
        } else {
          cursor += 1;
        }
      }
      const currentStatement = output.slice(output.lastIndexOf(';') + 1);
      const literalBody = source.slice(index + 1, closed ? cursor - 1 : cursor);
      if (/^\s*(?:DO|CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE))\b/i.test(currentStatement)
        && /\bEXECUTE\b/i.test(literalBody)
        && !dynamicSqlErrors.includes('dynamic_sql_unverifiable')) {
        dynamicSqlErrors.push('dynamic_sql_unverifiable');
      }
      output += source.slice(index, cursor).replace(/[^\n\r]/g, ' ');
      if (!closed) lexicalErrors.push('unterminated_string_literal');
      index = cursor;
      continue;
    }
    if (source[index] === '$') {
      const tag = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        const end = source.indexOf(tag, index + tag.length);
        const cursor = end === -1 ? source.length : end + tag.length;
        const body = source.slice(index + tag.length, end === -1 ? source.length : end);
        if (/\bEXECUTE\b/i.test(body)
          && !dynamicSqlErrors.includes('dynamic_sql_unverifiable')) {
          dynamicSqlErrors.push('dynamic_sql_unverifiable');
        }
        output += source.slice(index, cursor).replace(/[^\n\r]/g, ' ');
        if (end === -1) lexicalErrors.push('unterminated_dollar_quote');
        index = cursor;
        continue;
      }
    }
    if (source[index] === '"') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === '"' && source[cursor + 1] === '"') {
          cursor += 2;
        } else if (source[cursor] === '"') {
          cursor += 1;
          closed = true;
          break;
        } else {
          cursor += 1;
        }
      }
      output += source.slice(index, cursor);
      if (!closed) lexicalErrors.push('unterminated_quoted_identifier');
      index = cursor;
      continue;
    }
    output += source[index];
    index += 1;
  }
  return { sql: output, lexicalErrors, dynamicSqlErrors };
}

function splitIdentifierList(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') {
      if (quoted && value[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (value[index] === ',' && !quoted) {
      items.push(value.slice(start, index));
      start = index + 1;
    }
  }
  items.push(value.slice(start));
  return items;
}

function splitSqlStatements(value: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') {
      if (quoted && value[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (value[index] === ';' && !quoted) {
      statements.push(value.slice(start, index));
      start = index + 1;
    }
  }
  statements.push(value.slice(start));
  return statements.map((statement) => statement.trim()).filter(Boolean);
}

function identifierList(value: string): string[] {
  return splitIdentifierList(value).map((item) => normalizeIdentifier(item)).filter(Boolean);
}

function qualifiedIdentifier(value: string): CreatedTable | null {
  const match = value.trim().match(QUALIFIED_IDENTIFIER);
  if (!match) return null;
  const schema = normalizeIdentifier(match[1]);
  const table = normalizeIdentifier(match[2]);
  return { schema, table, relation: `${schema}.${table}` };
}

function clonePrivilegeState(state: PrivilegeState): PrivilegeState {
  return {
    schemaUsage: new Set(state.schemaUsage),
    tableSelect: new Set(state.tableSelect),
    forbiddenGrantOptions: new Set(state.forbiddenGrantOptions),
    unsafeGrantRecipients: new Set(state.unsafeGrantRecipients),
    forbiddenPrivilegeGrants: new Set(state.forbiddenPrivilegeGrants),
    publicPrivilegeGrants: new Set(state.publicPrivilegeGrants),
  };
}

function restorePrivilegeState(state: PrivilegeState, snapshot: PrivilegeState): void {
  for (const key of Object.keys(state) as Array<keyof PrivilegeState>) {
    state[key].clear();
    for (const value of snapshot[key]) state[key].add(value);
  }
}

function updatePrivilegeSet(
  targetSet: Set<string>,
  target: string,
  privileges: string[],
  allPrivileges: boolean,
  action: string,
): void {
  const prefix = `${target}:`;
  if (action === 'REVOKE') {
    if (allPrivileges) {
      for (const value of targetSet) {
        if (value.startsWith(prefix)) targetSet.delete(value);
      }
      return;
    }
    for (const privilege of privileges) targetSet.delete(`${prefix}${privilege}`);
    return;
  }
  for (const privilege of allPrivileges ? ['all'] : privileges) {
    targetSet.add(`${prefix}${privilege}`);
  }
}

function privilegesForTarget(targetSet: Set<string>, target: string): string[] {
  const prefix = `${target}:`;
  return [...targetSet]
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length))
    .sort();
}

function applyPrivilegeStatement(
  statement: string,
  state: PrivilegeState,
): boolean {
  const hasGrantOption = /\s+WITH\s+GRANT\s+OPTION\s*$/i.test(statement);
  const normalizedStatement = statement
    .replace(/\s+WITH\s+GRANT\s+OPTION\s*$/i, '')
    .replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, '');
  const schemaMatch = normalizedStatement.match(
    /^(GRANT|REVOKE)\s+(.+?)\s+ON\s+SCHEMA\s+(.+?)\s+(?:TO|FROM)\s+(.+?)$/i,
  );
  if (schemaMatch) {
    const [, action, rawPrivileges, rawSchemas, rawRoles] = schemaMatch;
    const privileges = identifierList(rawPrivileges);
    const roles = identifierList(rawRoles);
    const expectedRole = roles.includes(HUB_READONLY_GRANT_POLICY.role);
    const exactRecipients = roles.length === 1 && expectedRole;
    const publicRecipient = roles.includes('public');
    const normalizedAction = action.toUpperCase();
    const allPrivileges = /^all(?:\s+privileges)?$/i.test(rawPrivileges.trim());
    const includesUsage = allPrivileges || privileges.includes('usage');
    const extraPrivileges = allPrivileges ? ['all'] : privileges.filter((value) => value !== 'usage');
    for (const schema of identifierList(rawSchemas)) {
      const target = `schema:${schema}`;
      if (expectedRole) {
        if (normalizedAction === 'GRANT') {
          if (includesUsage) state.schemaUsage.add(schema);
          updatePrivilegeSet(state.forbiddenPrivilegeGrants, target, extraPrivileges, false, normalizedAction);
          if (!exactRecipients) state.unsafeGrantRecipients.add(target);
          if (hasGrantOption) state.forbiddenGrantOptions.add(target);
        } else {
          if (includesUsage) state.schemaUsage.delete(schema);
          updatePrivilegeSet(
            state.forbiddenPrivilegeGrants,
            target,
            privileges,
            allPrivileges,
            normalizedAction,
          );
          if (allPrivileges) state.forbiddenGrantOptions.delete(target);
        }
      }
      if (publicRecipient && !expectedRole) {
        updatePrivilegeSet(
          state.publicPrivilegeGrants,
          target,
          privileges,
          allPrivileges,
          normalizedAction,
        );
      }
    }
    return true;
  }

  const tableMatch = normalizedStatement.match(
    /^(GRANT|REVOKE)\s+(.+?)\s+ON\s+(?:TABLE\s+)?(.+?)\s+(?:TO|FROM)\s+(.+?)$/i,
  );
  if (!tableMatch) return false;
  const [, action, rawPrivileges, rawRelations, rawRoles] = tableMatch;
  const privileges = identifierList(rawPrivileges);
  const roles = identifierList(rawRoles);
  const expectedRole = roles.includes(HUB_READONLY_GRANT_POLICY.role);
  const exactRecipients = roles.length === 1 && expectedRole;
  const publicRecipient = roles.includes('public');
  const normalizedAction = action.toUpperCase();
  const allPrivileges = /^all(?:\s+privileges)?$/i.test(rawPrivileges.trim());
  const includesSelect = allPrivileges || privileges.includes('select');
  const extraPrivileges = allPrivileges ? ['all'] : privileges.filter((value) => value !== 'select');
  if (!expectedRole && !publicRecipient) return true;
  let relationsParsed = true;
  for (const rawRelation of splitIdentifierList(rawRelations)) {
    const relation = qualifiedIdentifier(rawRelation);
    if (!relation) {
      relationsParsed = false;
      continue;
    }
    const target = `table:${relation.relation}`;
    if (expectedRole) {
      if (normalizedAction === 'GRANT') {
        if (includesSelect) state.tableSelect.add(relation.relation);
        updatePrivilegeSet(state.forbiddenPrivilegeGrants, target, extraPrivileges, false, normalizedAction);
        if (!exactRecipients) state.unsafeGrantRecipients.add(target);
        if (hasGrantOption) state.forbiddenGrantOptions.add(target);
      } else {
        if (includesSelect) state.tableSelect.delete(relation.relation);
        updatePrivilegeSet(
          state.forbiddenPrivilegeGrants,
          target,
          privileges,
          allPrivileges,
          normalizedAction,
        );
        if (allPrivileges) state.forbiddenGrantOptions.delete(target);
      }
    }
    if (publicRecipient && !expectedRole) {
      updatePrivilegeSet(
        state.publicPrivilegeGrants,
        target,
        privileges,
        allPrivileges,
        normalizedAction,
      );
    }
  }
  return relationsParsed;
}

export function analyzeMigrationGrantContract(source: string) {
  const scrubbed = scrubSql(source);
  const statements = splitSqlStatements(scrubbed.sql);
  const createdTables: CreatedTable[] = [];
  const state: PrivilegeState = {
    schemaUsage: new Set<string>(),
    tableSelect: new Set<string>(),
    forbiddenGrantOptions: new Set<string>(),
    unsafeGrantRecipients: new Set<string>(),
    forbiddenPrivilegeGrants: new Set<string>(),
    publicPrivilegeGrants: new Set<string>(),
  };
  let transactionSnapshot: PrivilegeState | null = null;
  const violations: GrantViolation[] = scrubbed.lexicalErrors.map((error) => ({
    code: 'sql_lexical_error',
    message: `Migration SQL could not be parsed safely: ${error}.`,
  }));
  violations.push(...scrubbed.dynamicSqlErrors.map((error) => ({
    code: error,
    message: 'Dynamic migration SQL containing CREATE TABLE or privilege changes cannot be verified statically.',
  })));

  for (const statement of statements) {
    if (/^DO\b/i.test(statement)) {
      if (!violations.some((violation) => violation.code === 'dynamic_sql_unverifiable')) {
        violations.push({
          code: 'dynamic_sql_unverifiable',
          message: 'Procedural DO blocks require explicit migration review.',
        });
      }
      continue;
    }
    if (/^(?:BEGIN|START\s+TRANSACTION)\b/i.test(statement)) {
      if (transactionSnapshot) {
        violations.push({
          code: 'transaction_state_unverifiable',
          message: 'Nested migration transactions cannot be verified safely.',
        });
      } else {
        transactionSnapshot = clonePrivilegeState(state);
      }
      continue;
    }
    if (/^(?:PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+PREPARED)\b/i.test(statement)) {
      violations.push({
        code: 'transaction_state_unverifiable',
        message: 'Prepared migration transactions cannot be verified safely.',
      });
      continue;
    }
    if (/^COMMIT\b/i.test(statement)) {
      const chain = /\bAND\s+CHAIN\b/i.test(statement);
      if (chain && !transactionSnapshot) {
        violations.push({
          code: 'transaction_state_unverifiable',
          message: 'COMMIT AND CHAIN appears without a verifiable active transaction.',
        });
      }
      transactionSnapshot = chain ? clonePrivilegeState(state) : null;
      continue;
    }
    if (/^(?:SAVEPOINT|RELEASE\s+SAVEPOINT|ROLLBACK\s+TO)\b/i.test(statement)) {
      violations.push({
        code: 'transaction_state_unverifiable',
        message: 'Migration savepoints cannot be verified safely.',
      });
      continue;
    }
    if (/^ROLLBACK\b/i.test(statement)) {
      const chain = /\bAND\s+CHAIN\b/i.test(statement);
      if (transactionSnapshot) {
        restorePrivilegeState(state, transactionSnapshot);
      } else if (chain) {
        violations.push({
          code: 'transaction_state_unverifiable',
          message: 'ROLLBACK AND CHAIN appears without a verifiable active transaction.',
        });
      }
      transactionSnapshot = chain ? clonePrivilegeState(state) : null;
      continue;
    }
    if (/^EXECUTE\b/i.test(statement)) {
      violations.push({
        code: 'dynamic_sql_unverifiable',
        message: 'Dynamic migration SQL cannot be verified statically.',
      });
      continue;
    }
    if (/^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(statement)
      && /\b(?:hub_readonly|PUBLIC)\b/i.test(statement)) {
      violations.push({
        code: 'default_privilege_change_requires_review',
        message: 'hub_readonly default ACL changes require separate owner-scoped review.',
      });
      continue;
    }
    if (/^ALTER\s+(?:TABLE|SCHEMA)\b[\s\S]*\bOWNER\s+TO\s+"?hub_readonly"?\s*$/i.test(statement)) {
      violations.push({
        code: 'readonly_role_ownership_forbidden',
        message: 'hub_readonly must not own schemas or relations.',
      });
      continue;
    }
    const privilegeUnderstood = applyPrivilegeStatement(statement, state);
    if (/^(?:GRANT|REVOKE)\b/i.test(statement)
      && /\b(?:hub_readonly|PUBLIC)\b/i.test(statement)
      && !privilegeUnderstood) {
      violations.push({
        code: 'privilege_statement_unverifiable',
        message: 'Privilege statement affecting hub_readonly or PUBLIC requires explicit static review.',
      });
    }
    if (/^CREATE\s+(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+TABLE\b/i.test(statement)) continue;
    const createMatch = statement.match(
      new RegExp(`^CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})?)(?=\\s|\\(|$)`, 'i'),
    );
    if (!createMatch) {
      if (/^CREATE\s+(?:UNLOGGED\s+)?TABLE\b/i.test(statement)) {
        violations.push({
          code: 'table_identifier_unparseable',
          message: 'CREATE TABLE identifier could not be verified; use a static schema-qualified name.',
        });
      }
      continue;
    }
    const relation = qualifiedIdentifier(createMatch[1]);
    if (!relation) {
      const table = normalizeIdentifier(createMatch[1]);
      createdTables.push({ schema: null, table, relation: table });
      violations.push({
        code: 'table_schema_required',
        relation: table,
        message: `CREATE TABLE ${table} must use an approved schema-qualified identifier.`,
      });
      continue;
    }
    createdTables.push(relation);
  }

  if (transactionSnapshot) {
    violations.push({
      code: 'transaction_state_unverifiable',
      message: 'Migration transaction is not closed with COMMIT or ROLLBACK.',
    });
  }

  const approvedSchemas = new Set(HUB_READONLY_GRANT_POLICY.schemas);
  const eligibleTables: CreatedTable[] = [];
  for (const table of createdTables) {
    if (!table.schema) continue;
    if (!approvedSchemas.has(table.schema)) {
      violations.push({
        code: 'schema_not_approved',
        schema: table.schema,
        relation: table.relation,
        message: `${table.schema} is outside the hub_readonly grant policy and requires explicit review.`,
      });
      continue;
    }
    eligibleTables.push(table);
  }

  for (const schema of [...new Set(eligibleTables.map((table) => table.schema as string))]) {
    const target = `schema:${schema}`;
    if (state.unsafeGrantRecipients.has(target)) {
      violations.push({
        code: 'grant_recipient_scope_forbidden',
        schema,
        message: `The ${HUB_READONLY_GRANT_POLICY.role} schema grant must name only that role; grant other roles separately.`,
      });
    }
    if (state.forbiddenGrantOptions.has(target)) {
      violations.push({
        code: 'grant_option_forbidden',
        schema,
        message: `WITH GRANT OPTION is forbidden for ${HUB_READONLY_GRANT_POLICY.role}.`,
      });
    }
    const forbiddenPrivileges = privilegesForTarget(state.forbiddenPrivilegeGrants, target);
    if (forbiddenPrivileges.length > 0) {
      violations.push({
        code: 'grant_privilege_scope_forbidden',
        schema,
        message: `${HUB_READONLY_GRANT_POLICY.role} has forbidden schema privilege grants: ${forbiddenPrivileges.join(', ')}.`,
      });
    }
    const publicPrivileges = privilegesForTarget(state.publicPrivilegeGrants, target);
    if (publicPrivileges.length > 0) {
      violations.push({
        code: 'public_grant_forbidden',
        schema,
        message: `PUBLIC grants are forbidden on governed schema ${schema}: ${publicPrivileges.join(', ')}.`,
      });
    }
    if (!state.schemaUsage.has(schema)) {
      violations.push({
        code: 'schema_usage_grant_missing',
        schema,
        message: `GRANT USAGE ON SCHEMA ${schema} TO ${HUB_READONLY_GRANT_POLICY.role} is required.`,
      });
    }
  }
  for (const table of eligibleTables) {
    const target = `table:${table.relation}`;
    if (state.unsafeGrantRecipients.has(target)) {
      violations.push({
        code: 'grant_recipient_scope_forbidden',
        schema: table.schema as string,
        relation: table.relation,
        message: `The ${HUB_READONLY_GRANT_POLICY.role} table grant must name only that role; grant other roles separately.`,
      });
    }
    if (state.forbiddenGrantOptions.has(target)) {
      violations.push({
        code: 'grant_option_forbidden',
        schema: table.schema as string,
        relation: table.relation,
        message: `WITH GRANT OPTION is forbidden for ${HUB_READONLY_GRANT_POLICY.role}.`,
      });
    }
    const forbiddenPrivileges = privilegesForTarget(state.forbiddenPrivilegeGrants, target);
    if (forbiddenPrivileges.length > 0) {
      violations.push({
        code: 'grant_privilege_scope_forbidden',
        schema: table.schema as string,
        relation: table.relation,
        message: `${HUB_READONLY_GRANT_POLICY.role} has forbidden table privilege grants: ${forbiddenPrivileges.join(', ')}.`,
      });
    }
    const publicPrivileges = privilegesForTarget(state.publicPrivilegeGrants, target);
    if (publicPrivileges.length > 0) {
      violations.push({
        code: 'public_grant_forbidden',
        schema: table.schema as string,
        relation: table.relation,
        message: `PUBLIC grants are forbidden on governed relation ${table.relation}: ${publicPrivileges.join(', ')}.`,
      });
    }
    if (!state.tableSelect.has(table.relation)) {
      violations.push({
        code: 'table_select_grant_missing',
        schema: table.schema as string,
        relation: table.relation,
        message: `GRANT SELECT ON TABLE ${table.relation} TO ${HUB_READONLY_GRANT_POLICY.role} is required.`,
      });
    }
  }

  return { createdTables, violations };
}
