import { describe, expect, it } from "vitest";
import { EnvelopeError, errorCode, errorText } from "./engineFetch";

describe("errorText", () => {
  const cases: [EnvelopeError | Error | string, string][] = [
    [new EnvelopeError("ENGINE_UNREACHABLE", "Network error", 0), "Could not reach the server. Check the connection."],
    [new EnvelopeError("ENGINE_UNREACHABLE", "Request timed out", 0), "The server took too long to answer."],
    [new EnvelopeError("ENGINE_UNREACHABLE", "Unexpected response (HTTP 502)", 502), "The server sent an answer the page could not read."],
    [new EnvelopeError("ENGINE_UNREACHABLE", "Engine unreachable: boom", 503), "The trading engine is not answering right now."],
    [new EnvelopeError("UNAUTHORIZED", "invalid admin token", 401), "The admin token was not accepted."],
    [new EnvelopeError("CONFLICT", "kill switch is engaged; reset it before arming", 409), "Kill switch is engaged; reset it before arming."],
    [new EnvelopeError("INTERNAL", "stack trace", 500), "Something went wrong on the server."],
    [new TypeError("x is undefined"), "Something went wrong."],
    ["weird", "Something went wrong."],
  ];

  it.each(cases)("reads %s as a plain sentence", (err, text) => {
    expect(errorText(err)).toBe(text);
  });

  it("never shows a raw code, but keeps it for logic", () => {
    const err = new EnvelopeError("ENGINE_UNREACHABLE", "Network error", 0);
    expect(errorText(err)).not.toMatch(/[A-Z]{3,}_[A-Z]+/);
    expect(errorCode(err)).toBe("ENGINE_UNREACHABLE");
    expect(errorCode(new Error("x"))).toBeNull();
  });
});
