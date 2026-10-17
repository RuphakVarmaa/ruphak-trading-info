import { describe, expect, it } from "vitest";
import { ordinal } from "./text";

describe("ordinal", () => {
  it("uses st, nd and rd after 1, 2 and 3, except in the teens", () => {
    const ns = [0, 1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 62, 80, 100, 101, 111, 112];
    expect(ns.map(ordinal)).toEqual(["0th", "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "62nd", "80th", "100th", "101st", "111th", "112th"]);
  });
});
