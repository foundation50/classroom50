import { describe, expect, it } from "vitest"

import { parseCsvRows, parseCsvRowsStrictWidth } from "./csv"

type Row = { a?: string; b?: string; c?: string }

// One file, every width: a full row, one short by exactly one trailing cell,
// one short by two, one with a surplus cell, and a blank line.
const RAW = "a,b,c\n1,2,3\n4,5\n6\n7,8,9,10\n\n"

describe("parseCsvRows", () => {
  it("is the tolerant display read: every row, cells trimmed, blanks dropped", () => {
    expect(parseCsvRows<Row>(" a , b ,c\n 1 ,2,3\n\n")).toEqual([
      { a: "1", b: "2", c: "3" },
    ])
    expect(parseCsvRows<Row>(RAW)).toHaveLength(4)
  })
})

describe("parseCsvRowsStrictWidth", () => {
  it("keeps a row short by exactly one cell and drops the rest, like the CLI's lenient reader", () => {
    expect(parseCsvRowsStrictWidth<Row>(RAW)).toEqual([
      { a: "1", b: "2", c: "3" },
      { a: "4", b: "5" },
    ])
  })

  it("reads an empty file and a header-only file as no rows", () => {
    expect(parseCsvRowsStrictWidth<Row>("")).toEqual([])
    expect(parseCsvRowsStrictWidth<Row>("a,b,c\n")).toEqual([])
  })
})
