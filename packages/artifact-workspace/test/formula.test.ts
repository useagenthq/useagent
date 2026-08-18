import { describe, expect, test } from "bun:test";
import { evaluateWorkbook, type SheetCell, type Workbook } from "../src";

/** Build a one- or two-sheet workbook from A1-keyed cell maps for the tests. */
function workbook(
  sheet1: Record<string, SheetCell>,
  sheet2?: Record<string, SheetCell>,
): Workbook {
  const sheets = [
    { id: "s1", name: "Sheet1", rowCount: 50, colCount: 12, cells: sheet1 },
    ...(sheet2 ? [{ id: "s2", name: "Sheet2", rowCount: 50, colCount: 12, cells: sheet2 }] : []),
  ];
  return { schemaVersion: 2 as const, sheets, activeSheetId: "s1" };
}

/** The computed display of a cell on sheet1. */
function display(cells: Record<string, SheetCell>, ref: string): string {
  return evaluateWorkbook(workbook(cells)).cell("s1", ref).display;
}

describe("arithmetic + precedence", () => {
  test("respects operator precedence and parentheses", () => {
    expect(display({ A1: { v: "", f: "=1+2*3" } }, "A1")).toBe("7");
    expect(display({ A1: { v: "", f: "=(1+2)*3" } }, "A1")).toBe("9");
    expect(display({ A1: { v: "", f: "=10/2-3" } }, "A1")).toBe("2");
    expect(display({ A1: { v: "", f: "=-2+5" } }, "A1")).toBe("3");
  });

  test("references pull numeric values, including numeric-string literals", () => {
    const cells = { A1: { v: 10 }, A2: { v: "5" }, A3: { v: "", f: "=A1+A2" } };
    expect(display(cells, "A3")).toBe("15");
  });

  test("division by zero is #DIV/0! and text arithmetic is #VALUE!", () => {
    expect(display({ A1: { v: "", f: "=1/0" } }, "A1")).toBe("#DIV/0!");
    expect(display({ A1: { v: "hello" }, A2: { v: "", f: "=A1*2" } }, "A2")).toBe("#VALUE!");
  });
});

describe("range functions", () => {
  const data = {
    A1: { v: 10 },
    A2: { v: 20 },
    A3: { v: 30 },
    A4: { v: "text" }, // ignored by numeric aggregates
  };

  test("SUM / AVG / MIN / MAX / COUNT over a range", () => {
    expect(display({ ...data, B1: { v: "", f: "=SUM(A1:A4)" } }, "B1")).toBe("60");
    expect(display({ ...data, B1: { v: "", f: "=AVG(A1:A3)" } }, "B1")).toBe("20");
    expect(display({ ...data, B1: { v: "", f: "=AVERAGE(A1:A3)" } }, "B1")).toBe("20");
    expect(display({ ...data, B1: { v: "", f: "=MIN(A1:A3)" } }, "B1")).toBe("10");
    expect(display({ ...data, B1: { v: "", f: "=MAX(A1:A3)" } }, "B1")).toBe("30");
    // COUNT counts only numeric cells; the text cell A4 is excluded.
    expect(display({ ...data, B1: { v: "", f: "=COUNT(A1:A4)" } }, "B1")).toBe("3");
  });

  test("AVG of no numbers is #DIV/0!", () => {
    expect(display({ A1: { v: "x" }, B1: { v: "", f: "=AVG(A1:A1)" } }, "B1")).toBe("#DIV/0!");
  });

  test("mixed scalar + range arguments", () => {
    expect(display({ A1: { v: 5 }, A2: { v: 5 }, B1: { v: "", f: "=SUM(A1:A2,10)" } }, "B1")).toBe("20");
  });
});

describe("IF + comparisons", () => {
  test("IF picks a branch by comparison", () => {
    expect(display({ A1: { v: 150 }, B1: { v: "", f: '=IF(A1>100,"High","Low")' } }, "B1")).toBe("High");
    expect(display({ A1: { v: 50 }, B1: { v: "", f: '=IF(A1>100,"High","Low")' } }, "B1")).toBe("Low");
  });

  test("comparison operators yield booleans", () => {
    expect(display({ A1: { v: "", f: "=2<>3" } }, "A1")).toBe("TRUE");
    expect(display({ A1: { v: "", f: "=2>=3" } }, "A1")).toBe("FALSE");
  });
});

describe("cross-sheet references", () => {
  test("resolves Sheet2!A1 in a formula", () => {
    const evaluation = evaluateWorkbook(
      workbook({ A1: { v: "", f: "=Sheet2!A1*2" } }, { A1: { v: 21 } }),
    );
    expect(evaluation.cell("s1", "A1").display).toBe("42");
  });

  test("an unknown sheet name is #REF!", () => {
    expect(display({ A1: { v: "", f: "=Nope!A1" } }, "A1")).toBe("#REF!");
  });
});

describe("errors", () => {
  test("a direct self-reference is a cycle", () => {
    expect(display({ A1: { v: "", f: "=A1+1" } }, "A1")).toBe("#CYCLE!");
  });

  test("a mutual reference cycle is #CYCLE! for both cells", () => {
    const cells = { A1: { v: "", f: "=B1" }, B1: { v: "", f: "=A1" } };
    expect(display(cells, "A1")).toBe("#CYCLE!");
    expect(display(cells, "B1")).toBe("#CYCLE!");
  });

  test("an unknown function is #NAME? and malformed syntax is #ERR!", () => {
    expect(display({ A1: { v: "", f: "=VLOOKUP(A2,A1:B2,2)" } }, "A1")).toBe("#NAME?");
    expect(display({ A1: { v: "", f: "=1+" } }, "A1")).toBe("#ERR!");
  });

  test("an error in a range propagates through SUM", () => {
    const cells = { A1: { v: "", f: "=1/0" }, B1: { v: "", f: "=SUM(A1:A2)" } };
    expect(display(cells, "B1")).toBe("#DIV/0!");
  });
});

describe("number formatting", () => {
  test("applies currency, percent, and decimal formats to numeric values", () => {
    expect(display({ A1: { v: 1200000, fmt: { numFmt: "currency" } } }, "A1")).toBe("$1,200,000.00");
    expect(display({ A1: { v: 0.35, fmt: { numFmt: "percent" } } }, "A1")).toBe("35%");
    // A repeating ratio rounds to two decimals rather than a long tail.
    expect(
      display(
        { A1: { v: 1420000 }, A2: { v: 3720000 }, B1: { v: "", f: "=A1/A2", fmt: { numFmt: "percent" } } },
        "B1",
      ),
    ).toBe("38.17%");
    expect(display({ A1: { v: 3.14159, fmt: { numFmt: "0.00" } } }, "A1")).toBe("3.14");
    expect(display({ A1: { v: 3.7, fmt: { numFmt: "0" } } }, "A1")).toBe("4");
  });

  test("a formula result is formatted and float noise is trimmed", () => {
    expect(display({ A1: { v: "", f: "=0.1+0.2" } }, "A1")).toBe("0.3");
    expect(
      display({ A1: { v: 100 }, A2: { v: 3 }, B1: { v: "", f: "=A1/A2", fmt: { numFmt: "0.00" } } }, "B1"),
    ).toBe("33.33");
  });

  test("a numeric format on non-numeric text shows the text unchanged", () => {
    expect(display({ A1: { v: "hello", fmt: { numFmt: "currency" } } }, "A1")).toBe("hello");
  });
});
