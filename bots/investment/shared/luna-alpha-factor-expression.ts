// @ts-nocheck

const DEFAULT_MAX_COMPLEXITY = 12;

export const ALPHA_ALLOWED_FIELDS = Object.freeze(new Set([
  'open',
  'high',
  'low',
  'close',
  'volume',
  'value',
  'quality',
  'growth',
  'size',
  'liquidity',
  'marketCap',
  'pbr',
  'roe',
  'revenueGrowth',
  'momentum',
  'return_1d',
  'return_5d',
  'return_20d',
  'return_60d',
  'volatility_20d',
]));

const ALPHA_ALLOWED_FUNCTIONS = Object.freeze(new Set([
  'abs',
  'log',
  'sqrt',
  'min',
  'max',
]));

const BANNED_EXPRESSION_PATTERNS = [
  /\beval\b/i,
  /\bFunction\b/,
  /\brequire\b/,
  /\bimport\b/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\bwindow\b/,
  /\bfetch\b/,
  /\bXMLHttpRequest\b/,
  /\bfs\b/,
  /\bchild_process\b/,
  /=>/,
  /[;{}[\]'"]/,
];

function assertSafeExpressionText(expression: string) {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new Error('alpha_expression_empty');
  }
  if (expression.length > 512) {
    throw new Error('alpha_expression_too_long');
  }
  for (const pattern of BANNED_EXPRESSION_PATTERNS) {
    if (pattern.test(expression)) {
      throw new Error('alpha_expression_forbidden_token');
    }
  }
}

function tokenize(expression: string) {
  assertSafeExpressionText(expression);
  const tokens = [];
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if ('()+-*/,'.includes(ch)) {
      tokens.push({ type: ch, value: ch });
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      let dots = 0;
      while (j < expression.length && /[0-9.]/.test(expression[j])) {
        if (expression[j] === '.') dots += 1;
        j += 1;
      }
      if (dots > 1) throw new Error('alpha_expression_invalid_number');
      const value = Number(expression.slice(i, j));
      if (!Number.isFinite(value)) throw new Error('alpha_expression_invalid_number');
      tokens.push({ type: 'number', value });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < expression.length && /[A-Za-z0-9_]/.test(expression[j])) j += 1;
      tokens.push({ type: 'identifier', value: expression.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`alpha_expression_invalid_char:${ch}`);
  }
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
    this.fields = new Set();
    this.functions = new Set();
    this.complexity = 0;
  }

  peek() {
    return this.tokens[this.index];
  }

  consume(type) {
    const token = this.peek();
    if (token.type !== type) throw new Error(`alpha_expression_expected_${type}`);
    this.index += 1;
    return token;
  }

  parse() {
    const ast = this.parseExpression();
    this.consume('eof');
    return ast;
  }

  parseExpression() {
    let node = this.parseTerm();
    while (this.peek().type === '+' || this.peek().type === '-') {
      const op = this.consume(this.peek().type).value;
      node = { type: 'binary', op, left: node, right: this.parseTerm() };
      this.complexity += 1;
    }
    return node;
  }

  parseTerm() {
    let node = this.parseUnary();
    while (this.peek().type === '*' || this.peek().type === '/') {
      const op = this.consume(this.peek().type).value;
      node = { type: 'binary', op, left: node, right: this.parseUnary() };
      this.complexity += 1;
    }
    return node;
  }

  parseUnary() {
    if (this.peek().type === '-') {
      this.consume('-');
      this.complexity += 1;
      return { type: 'unary', op: '-', value: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.peek();
    if (token.type === 'number') {
      this.consume('number');
      return { type: 'number', value: token.value };
    }
    if (token.type === 'identifier') {
      const name = this.consume('identifier').value;
      if (this.peek().type === '(') {
        if (!ALPHA_ALLOWED_FUNCTIONS.has(name)) throw new Error(`alpha_expression_forbidden_function:${name}`);
        this.consume('(');
        const args = [];
        if (this.peek().type !== ')') {
          args.push(this.parseExpression());
          while (this.peek().type === ',') {
            this.consume(',');
            args.push(this.parseExpression());
          }
        }
        this.consume(')');
        this.functions.add(name);
        this.complexity += 1;
        return { type: 'call', name, args };
      }
      if (!ALPHA_ALLOWED_FIELDS.has(name)) throw new Error(`alpha_expression_forbidden_field:${name}`);
      this.fields.add(name);
      return { type: 'field', name };
    }
    if (token.type === '(') {
      this.consume('(');
      const node = this.parseExpression();
      this.consume(')');
      return node;
    }
    throw new Error(`alpha_expression_unexpected_${token.type}`);
  }
}

export function parseAlphaExpression(expression: string, options: any = {}) {
  const parser = new Parser(tokenize(expression));
  const ast = parser.parse();
  const complexity = parser.complexity + parser.fields.size + parser.functions.size;
  const maxComplexity = Number(options.maxComplexity ?? DEFAULT_MAX_COMPLEXITY);
  if (complexity > maxComplexity) {
    throw new Error(`alpha_expression_complexity_exceeded:${complexity}`);
  }
  return {
    expression,
    ast,
    complexity,
    fields: Array.from(parser.fields).sort(),
    functions: Array.from(parser.functions).sort(),
  };
}

function numeric(value: any) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function evalAst(node: any, row: any) {
  if (!node) return null;
  if (node.type === 'number') return node.value;
  if (node.type === 'field') return numeric(row?.[node.name]);
  if (node.type === 'unary') {
    const value = evalAst(node.value, row);
    if (value == null) return null;
    return node.op === '-' ? -value : value;
  }
  if (node.type === 'binary') {
    const left = evalAst(node.left, row);
    const right = evalAst(node.right, row);
    if (left == null || right == null) return null;
    if (node.op === '+') return left + right;
    if (node.op === '-') return left - right;
    if (node.op === '*') return left * right;
    if (node.op === '/') return Math.abs(right) < 1e-12 ? null : left / right;
  }
  if (node.type === 'call') {
    const args = node.args.map((arg) => evalAst(arg, row));
    if (args.some((value) => value == null)) return null;
    if (node.name === 'abs') return Math.abs(args[0]);
    if (node.name === 'log') return args[0] > 0 ? Math.log(args[0]) : null;
    if (node.name === 'sqrt') return args[0] >= 0 ? Math.sqrt(args[0]) : null;
    if (node.name === 'min') return Math.min(...args);
    if (node.name === 'max') return Math.max(...args);
  }
  return null;
}

export function evaluateAlphaExpression(expressionOrParsed: any, row: any, options: any = {}) {
  const parsed = typeof expressionOrParsed === 'string'
    ? parseAlphaExpression(expressionOrParsed, options)
    : expressionOrParsed;
  const value = evalAst(parsed.ast || parsed, row);
  return Number.isFinite(value) ? value : null;
}

export function validateAlphaCandidate(candidate: any, options: any = {}) {
  const name = String(candidate?.name || '').trim();
  const expression = String(candidate?.expression || '').trim();
  const hypothesis = String(candidate?.hypothesis || '').trim();
  if (!name) throw new Error('alpha_candidate_name_required');
  if (!hypothesis || hypothesis.length < 12) throw new Error('alpha_candidate_hypothesis_required');
  const parsed = parseAlphaExpression(expression, options);
  return {
    name,
    expression,
    hypothesis,
    complexity: parsed.complexity,
    fields: parsed.fields,
    functions: parsed.functions,
    universe: candidate?.universe || options.universe || 'domestic_equity',
    generatedBy: candidate?.generatedBy || 'unknown',
  };
}

export function normalizeAlphaCandidate(candidate: any, options: any = {}) {
  return validateAlphaCandidate(candidate, options);
}
