/**
 * Simple expression evaluator for dimension parameters.
 * Supports: +, -, *, /, unary minus, parentheses, numbers, identifiers.
 *
 * Grammar:
 *   expr    = term (('+' | '-') term)*
 *   term    = unary (('*' | '/') unary)*
 *   unary   = '-' unary | primary
 *   primary = NUMBER | IDENTIFIER | '(' expr ')'
 */

interface Token {
  type: 'number' | 'ident' | 'op' | 'lparen' | 'rparen';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '(') { tokens.push({ type: 'lparen', value: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ')' }); i++; continue; }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'op', value: ch }); i++; continue;
    }
    // Number: digits, optional dot, digits
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let num = '';
      while (i < input.length && ((input[i]! >= '0' && input[i]! <= '9') || input[i] === '.')) {
        num += input[i]; i++;
      }
      tokens.push({ type: 'number', value: num });
      continue;
    }
    // Identifier: [a-zA-Z_][a-zA-Z0-9_]*
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let id = '';
      while (i < input.length) {
        const c = input[i]!;
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_') {
          id += c; i++;
        } else break;
      }
      tokens.push({ type: 'ident', value: id });
      continue;
    }
    throw new Error(`Unexpected character: '${ch}'`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[], private vars: Record<string, number>) {}

  parse(): number {
    const result = this.expr();
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token: '${this.tokens[this.pos]!.value}'`);
    }
    return result;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    return this.tokens[this.pos++]!;
  }

  private expr(): number {
    let left = this.term();
    while (this.peek()?.type === 'op' && (this.peek()!.value === '+' || this.peek()!.value === '-')) {
      const op = this.consume().value;
      const right = this.term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private term(): number {
    let left = this.unary();
    while (this.peek()?.type === 'op' && (this.peek()!.value === '*' || this.peek()!.value === '/')) {
      const op = this.consume().value;
      const right = this.unary();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  private unary(): number {
    if (this.peek()?.type === 'op' && this.peek()!.value === '-') {
      this.consume();
      return -this.unary();
    }
    return this.primary();
  }

  private primary(): number {
    const tok = this.peek();
    if (!tok) throw new Error('Unexpected end of expression');

    if (tok.type === 'number') {
      this.consume();
      const v = parseFloat(tok.value);
      if (isNaN(v)) throw new Error(`Invalid number: '${tok.value}'`);
      return v;
    }

    if (tok.type === 'ident') {
      this.consume();
      if (!(tok.value in this.vars)) {
        throw new Error(`Unknown variable: '${tok.value}'`);
      }
      return this.vars[tok.value]!;
    }

    if (tok.type === 'lparen') {
      this.consume();
      const val = this.expr();
      const closing = this.peek();
      if (!closing || closing.type !== 'rparen') {
        throw new Error('Expected closing parenthesis');
      }
      this.consume();
      return val;
    }

    throw new Error(`Unexpected token: '${tok.value}'`);
  }
}

/** Evaluate an expression string against a set of named variables. Throws on error. */
export function evaluateExpression(input: string, vars: Record<string, number>): number {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Empty expression');
  const tokens = tokenize(trimmed);
  return new Parser(tokens, vars).parse();
}

/** Returns true if the input contains letters (i.e. is not a plain number). */
export function isExpression(input: string): boolean {
  return /[a-zA-Z_]/.test(input);
}

/** Returns true if the name is a valid parameter name: [a-zA-Z_][a-zA-Z0-9_]* */
export function isValidParamName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}
