import { GitCommandError } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { toError } from "./transport.ts";

describe("toError", () => {
  it("passes a contract error through so its tag survives", () => {
    const failure = new GitCommandError({
      operation: "merge",
      command: "git merge feature",
      cwd: "/srv/app",
      detail: "conflicts",
    });

    expect(toError(failure)).toBe(failure);
  });

  it("wraps a plain rejection that only carries a message", () => {
    const error = toError({ message: "socket closed" });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("socket closed");
  });

  it("stringifies anything else", () => {
    expect(toError("boom").message).toBe("boom");
    expect(toError(null).message).toBe("null");
  });
});
