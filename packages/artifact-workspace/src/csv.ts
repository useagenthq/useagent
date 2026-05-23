// RFC-4180-ish CSV parse/serialize shared by every artifact consumer (the grid,
// the workbook migration, the exporters, and the proposal diff). No I/O, no DOM.

export function parseArtifactCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }
  row.push(cell);
  if (row.some((value) => value.length > 0) || rows.length === 0) rows.push(row);
  return rows;
}

export function serializeArtifactCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) =>
    row.map((value) => /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)
      .join(",")
  ).join("\n");
}
