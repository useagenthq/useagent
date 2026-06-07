// A bounded, dependency-free spreadsheet formula engine (our own, like the
// a reference sheet engine sheet). It evaluates a workbook on the client at render/edit time:
// arithmetic (+ - * /), cell refs, ranges, SUM, AVG/AVERAGE, MIN, MAX, COUNT, IF,
// comparisons, and cross-sheet refs (Sheet2!A1). Formulas are the source of truth;
// this computes the display value. Cycles yield #CYCLE!, bad refs #REF!, and
// division by zero #DIV/0!. Pure: no I/O, no DOM. VLOOKUP is deliberately NOT
// shipped (see the spreadsheet fidelity note) - the supported set is small so it
// can be exhaustively tested.

import { formatA1, parseA1 } from "./spreadsheet";
import type { SheetCell, SheetNumberFormat, Workbook, Worksheet } from "./contracts";

export type CellError = "#REF!" | "#CYCLE!" | "#DIV/0!" | "#NAME?" | "#VALUE!" | "#ERR!";
export type FormulaScalar = number | string | boolean;
type Value = FormulaScalar | CellError;

const CELL_ERRORS: ReadonlySet<string> = new Set([
  "#REF!",
  "#CYCLE!",
  "#DIV/0!",
  "#NAME?",
  "#VALUE!",
  "#ERR!",
]);

function isError(value: unknown): value is CellError {
  return typeof value === "string" && CELL_ERRORS.has(value);
}

/** The rendered form of one cell: its computed scalar (or null on error), an
 * error code when the formula failed, whether it is numeric (for default
 * alignment), and the format-applied display string the grid draws. */
export interface EvaluatedCell {
  readonly value: FormulaScalar | null;
  readonly error: CellError | null;
  readonly numeric: boolean;
  readonly display: string;
}

const EMPTY_CELL: EvaluatedCell = { value: null, error: null, numeric: false, display: "" };

/** Protect the main thread: a single range may not expand past this many cells. */
const MAX_RANGE_CELLS = 200_000;
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** The number a scalar contributes to arithmetic: empty is 0, a numeric string
 * parses, a boolean is 1/0, and non-numeric text is a #VALUE! error. */
function toNumber(value: Value): number | CellError {
  if (isError(value)) return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  return NUMERIC.test(trimmed) ? Number(trimmed) : "#VALUE!";
}

/** The number a scalar contributes to an aggregate (SUM/AVG/MIN/MAX/COUNT), or
 * null when it is text/empty and should be ignored. Errors propagate. */
function toNumericOrNull(value: Value): number | null | CellError {
  if (isError(value)) return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return null;
  const trimmed = value.trim();
  if (trimmed === "" || !NUMERIC.test(trimmed)) return null;
  return Number(trimmed);
}

function toBoolean(value: Value): boolean | CellError {
  if (isError(value)) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (NUMERIC.test(trimmed)) return Number(trimmed) !== 0;
  const lower = trimmed.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  return "#VALUE!";
}

// --- AST + parser ----------------------------------------------------------

type Node =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "ref"; sheet: string | null; ref: string }
  | { kind: "range"; sheet: string | null; from: string; to: string }
  | { kind: "unary"; op: "+" | "-"; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

type Token =
  | { t: "num"; value: number }
  | { t: "str"; value: string }
  | { t: "ident"; value: string }
  | { t: "quoted"; value: string }
  | { t: "op"; value: string };

class FormulaSyntaxError extends Error {}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = "";
      i += 1;
      while (i < n) {
        if (input[i] === '"' && input[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        if (input[i] === '"') {
          i += 1;
          break;
        }
        value += input[i];
        i += 1;
      }
      tokens.push({ t: "str", value });
      continue;
    }
    if (ch === "'") {
      let value = "";
      i += 1;
      while (i < n && input[i] !== "'") {
        value += input[i];
        i += 1;
      }
      if (input[i] !== "'") throw new FormulaSyntaxError("unterminated sheet name");
      i += 1;
      tokens.push({ t: "quoted", value });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(input[i + 1] ?? ""))) {
      const match = /^\d+\.?\d*([eE][+-]?\d+)?|^\.\d+([eE][+-]?\d+)?/.exec(input.slice(i));
      if (!match) throw new FormulaSyntaxError("bad number");
      tokens.push({ t: "num", value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(input.slice(i))!;
      tokens.push({ t: "ident", value: match[0] });
      i += match[0].length;
      continue;
    }
    // Multi-char operators first.
    const two = input.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      tokens.push({ t: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/()<>=,:!&".includes(ch)) {
      tokens.push({ t: "op", value: ch });
      i += 1;
      continue;
    }
    throw new FormulaSyntaxError(`unexpected character ${ch}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.comparison();
    if (this.pos < this.tokens.length) throw new FormulaSyntaxError("trailing tokens");
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private eatOp(value: string): boolean {
    const token = this.peek();
    if (token?.t === "op" && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private comparison(): Node {
    let left = this.additive();
    for (;;) {
      const token = this.peek();
      if (token?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(token.value)) {
        this.pos += 1;
        left = { kind: "binary", op: token.value, left, right: this.additive() };
      } else {
        return left;
      }
    }
  }

  private additive(): Node {
    let left = this.multiplicative();
    for (;;) {
      const token = this.peek();
      if (token?.t === "op" && (token.value === "+" || token.value === "-")) {
        this.pos += 1;
        left = { kind: "binary", op: token.value, left, right: this.multiplicative() };
      } else {
        return left;
      }
    }
  }

  private multiplicative(): Node {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (token?.t === "op" && (token.value === "*" || token.value === "/")) {
        this.pos += 1;
        left = { kind: "binary", op: token.value, left, right: this.unary() };
      } else {
        return left;
      }
    }
  }

  private unary(): Node {
    const token = this.peek();
    if (token?.t === "op" && (token.value === "+" || token.value === "-")) {
      this.pos += 1;
      return { kind: "unary", op: token.value, operand: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.peek();
    if (!token) throw new FormulaSyntaxError("unexpected end of formula");

    if (token.t === "op" && token.value === "(") {
      this.pos += 1;
      const node = this.comparison();
      if (!this.eatOp(")")) throw new FormulaSyntaxError("expected )");
      return node;
    }
    if (token.t === "num") {
      this.pos += 1;
      return { kind: "num", value: token.value };
    }
    if (token.t === "str") {
      this.pos += 1;
      return { kind: "str", value: token.value };
    }
    if (token.t === "quoted") {
      // A quoted sheet name must be followed by ! and a cell ref.
      this.pos += 1;
      if (!this.eatOp("!")) throw new FormulaSyntaxError("expected ! after sheet name");
      return this.referenceOrRange(token.value);
    }
    if (token.t === "ident") {
      this.pos += 1;
      const next = this.peek();
      if (next?.t === "op" && next.value === "(") {
        this.pos += 1;
        const args = this.args();
        if (!this.eatOp(")")) throw new FormulaSyntaxError("expected )");
        return { kind: "call", name: token.value.toUpperCase(), args };
      }
      if (next?.t === "op" && next.value === "!") {
        this.pos += 1;
        return this.referenceOrRange(token.value);
      }
      const upper = token.value.toUpperCase();
      if (upper === "TRUE") return { kind: "bool", value: true };
      if (upper === "FALSE") return { kind: "bool", value: false };
      return this.finishReference(null, token.value);
    }
    throw new FormulaSyntaxError("unexpected token");
  }

  private args(): Node[] {
    const args: Node[] = [];
    if (this.peek()?.t === "op" && (this.peek() as { value: string }).value === ")") return args;
    for (;;) {
      args.push(this.comparison());
      if (this.eatOp(",")) continue;
      return args;
    }
  }

  /** Build a single cell reference (already past any sheet!): the ident that
   * follows is the A1, and an optional `:` extends it to a range. */
  private referenceOrRange(sheet: string): Node {
    const token = this.peek();
    if (token?.t !== "ident") throw new FormulaSyntaxError("expected cell reference");
    this.pos += 1;
    return this.finishReference(sheet, token.value);
  }

  private finishReference(sheet: string | null, first: string): Node {
    if (this.eatOp(":")) {
      const token = this.peek();
      if (token?.t !== "ident") throw new FormulaSyntaxError("expected range end");
      this.pos += 1;
      return { kind: "range", sheet, from: first, to: token.value };
    }
    return { kind: "ref", sheet, ref: first };
  }
}

function parseFormula(source: string): Node {
  return new Parser(tokenize(source)).parse();
}

// --- Evaluation ------------------------------------------------------------

function literalScalar(cell: SheetCell): FormulaScalar {
  return cell.v;
}

export interface WorkbookEvaluation {
  /** The rendered cell at a sheet + A1 ref (empty when the cell is blank). */
  cell(sheetId: string, ref: string): EvaluatedCell;
}

/** Build a memoized evaluation over a workbook. Every cell is computed at most
 * once; cross-sheet refs and cycle detection span the whole workbook. */
export function evaluateWorkbook(workbook: Workbook): WorkbookEvaluation {
  const byId = new Map<string, Worksheet>(workbook.sheets.map((sheet) => [sheet.id, sheet]));
  const byName = new Map<string, Worksheet>(
    workbook.sheets.map((sheet) => [sheet.name.toLowerCase(), sheet]),
  );
  const valueCache = new Map<string, Value>();
  const evaluatedCache = new Map<string, EvaluatedCell>();
  const visiting = new Set<string>();

  function rawCell(sheetId: string, ref: string): SheetCell | undefined {
    const position = parseA1(ref);
    if (!position) return undefined;
    return byId.get(sheetId)?.cells[formatA1(position.row, position.col)];
  }

  function resolveSheetId(sheet: string | null, currentSheetId: string): string | null {
    if (sheet === null) return currentSheetId;
    const target = byName.get(sheet.toLowerCase());
    return target ? target.id : null;
  }

  function resolveValue(sheetId: string, ref: string): Value {
    const position = parseA1(ref);
    if (!position) return "#REF!";
    const key = `${sheetId}!${formatA1(position.row, position.col)}`;
    const cached = valueCache.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return "#CYCLE!";
    const cell = byId.get(sheetId)?.cells[formatA1(position.row, position.col)];
    if (!cell) return "";
    if (cell.f === undefined) {
      const literal = literalScalar(cell);
      valueCache.set(key, literal);
      return literal;
    }
    visiting.add(key);
    let result: Value;
    try {
      result = evalNode(parseFormula(cell.f.slice(1)), sheetId);
    } catch {
      result = "#ERR!";
    }
    visiting.delete(key);
    valueCache.set(key, result);
    return result;
  }

  function rangeValues(node: Extract<Node, { kind: "range" }>, currentSheetId: string): Value[] | CellError {
    const sheetId = resolveSheetId(node.sheet, currentSheetId);
    if (!sheetId) return "#REF!";
    const from = parseA1(node.from);
    const to = parseA1(node.to);
    if (!from || !to) return "#REF!";
    const r0 = Math.min(from.row, to.row);
    const r1 = Math.max(from.row, to.row);
    const c0 = Math.min(from.col, to.col);
    const c1 = Math.max(from.col, to.col);
    if ((r1 - r0 + 1) * (c1 - c0 + 1) > MAX_RANGE_CELLS) return "#VALUE!";
    const values: Value[] = [];
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        values.push(resolveValue(sheetId, formatA1(r, c)));
      }
    }
    return values;
  }

  /** Flatten function arguments (scalars and ranges) into numeric contributions;
   * text/empty are ignored, an error short-circuits the whole aggregate. */
  function collectNumbers(args: Node[], currentSheetId: string): number[] | CellError {
    const numbers: number[] = [];
    for (const arg of args) {
      if (arg.kind === "range") {
        const values = rangeValues(arg, currentSheetId);
        if (isError(values)) return values;
        for (const value of values) {
          const num = toNumericOrNull(value);
          if (isError(num)) return num;
          if (num !== null) numbers.push(num);
        }
        continue;
      }
      const value = evalNode(arg, currentSheetId);
      const num = toNumericOrNull(value);
      if (isError(num)) return num;
      if (num !== null) numbers.push(num);
    }
    return numbers;
  }

  function evalCall(node: Extract<Node, { kind: "call" }>, currentSheetId: string): Value {
    const name = node.name;
    if (name === "IF") {
      if (node.args.length < 2 || node.args.length > 3) return "#ERR!";
      const condition = toBoolean(evalNode(node.args[0]!, currentSheetId));
      if (isError(condition)) return condition;
      if (condition) return evalNode(node.args[1]!, currentSheetId);
      return node.args[2] ? evalNode(node.args[2], currentSheetId) : false;
    }
    if (name === "SUM" || name === "AVG" || name === "AVERAGE" || name === "MIN" || name === "MAX" || name === "COUNT") {
      const numbers = collectNumbers(node.args, currentSheetId);
      if (isError(numbers)) return numbers;
      if (name === "COUNT") return numbers.length;
      if (name === "SUM") return numbers.reduce((sum, value) => sum + value, 0);
      if (name === "AVG" || name === "AVERAGE") {
        return numbers.length === 0 ? "#DIV/0!" : numbers.reduce((s, v) => s + v, 0) / numbers.length;
      }
      if (numbers.length === 0) return 0;
      return name === "MIN" ? Math.min(...numbers) : Math.max(...numbers);
    }
    return "#NAME?";
  }

  function compare(op: string, left: Value, right: Value): Value {
    if (isError(left)) return left;
    if (isError(right)) return right;
    const bothNumbers = typeof left === "number" && typeof right === "number";
    let cmp: number;
    if (bothNumbers) {
      cmp = left < right ? -1 : left > right ? 1 : 0;
    } else {
      const a = String(left).toLowerCase();
      const b = String(right).toLowerCase();
      cmp = a < b ? -1 : a > b ? 1 : 0;
    }
    switch (op) {
      case "=":
        return cmp === 0;
      case "<>":
        return cmp !== 0;
      case "<":
        return cmp < 0;
      case ">":
        return cmp > 0;
      case "<=":
        return cmp <= 0;
      case ">=":
        return cmp >= 0;
      default:
        return "#ERR!";
    }
  }

  function evalNode(node: Node, currentSheetId: string): Value {
    switch (node.kind) {
      case "num":
        return node.value;
      case "str":
        return node.value;
      case "bool":
        return node.value;
      case "ref": {
        const sheetId = resolveSheetId(node.sheet, currentSheetId);
        if (!sheetId) return "#REF!";
        if (!parseA1(node.ref)) return "#REF!";
        return resolveValue(sheetId, node.ref);
      }
      case "range":
        // A range in scalar position is not a value.
        return "#VALUE!";
      case "unary": {
        const operand = toNumber(evalNode(node.operand, currentSheetId));
        if (isError(operand)) return operand;
        return node.op === "-" ? -operand : operand;
      }
      case "binary": {
        if (["=", "<>", "<", ">", "<=", ">="].includes(node.op)) {
          return compare(
            node.op,
            evalNode(node.left, currentSheetId),
            evalNode(node.right, currentSheetId),
          );
        }
        const left = toNumber(evalNode(node.left, currentSheetId));
        if (isError(left)) return left;
        const right = toNumber(evalNode(node.right, currentSheetId));
        if (isError(right)) return right;
        switch (node.op) {
          case "+":
            return left + right;
          case "-":
            return left - right;
          case "*":
            return left * right;
          case "/":
            return right === 0 ? "#DIV/0!" : left / right;
          default:
            return "#ERR!";
        }
      }
      case "call":
        return evalCall(node, currentSheetId);
    }
  }

  function evaluate(sheetId: string, ref: string): EvaluatedCell {
    const position = parseA1(ref);
    if (!position) return EMPTY_CELL;
    const canonical = formatA1(position.row, position.col);
    const key = `${sheetId}!${canonical}`;
    const cached = evaluatedCache.get(key);
    if (cached) return cached;
    const cell = byId.get(sheetId)?.cells[canonical];
    if (!cell) return EMPTY_CELL;
    const value = cell.f === undefined ? literalScalar(cell) : resolveValue(sheetId, ref);
    const evaluated = renderCell(cell, value);
    evaluatedCache.set(key, evaluated);
    return evaluated;
  }

  return { cell: evaluate };
}

// --- Display formatting ----------------------------------------------------

function numericScalar(value: Value): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean" || isError(value)) return null;
  const trimmed = value.trim();
  return trimmed !== "" && NUMERIC.test(trimmed) ? Number(trimmed) : null;
}

/** A clean plain-number string with float noise trimmed (0.30000000004 -> 0.3). */
function plainNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Number(value.toFixed(10)));
}

function applyNumberFormat(numeric: number, numFmt: SheetNumberFormat): string {
  switch (numFmt) {
    case "currency": {
      const body = Math.abs(numeric).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return `${numeric < 0 ? "-" : ""}$${body}`;
    }
    case "percent":
      return `${plainNumber(Math.round(numeric * 10000) / 100)}%`;
    case "0":
      return String(Math.round(numeric));
    case "0.00":
      return numeric.toFixed(2);
    default:
      return plainNumber(numeric);
  }
}

/** Render a resolved cell value into { value, error, numeric, display }, applying
 * the cell's number format. Exported for the grid and the proposal diff. */
export function renderCell(cell: SheetCell, value: Value): EvaluatedCell {
  if (isError(value)) return { value: null, error: value, numeric: false, display: value };
  const numeric = numericScalar(value);
  const numFmt = cell.fmt?.numFmt ?? "auto";
  if (numeric !== null && (typeof value === "number" || numFmt !== "auto")) {
    return { value, error: null, numeric: true, display: applyNumberFormat(numeric, numFmt) };
  }
  if (typeof value === "boolean") {
    return { value, error: null, numeric: false, display: value ? "TRUE" : "FALSE" };
  }
  return { value, error: null, numeric: numeric !== null, display: String(value) };
}
