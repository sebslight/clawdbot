import { describe, expect, it } from "vitest";

import { renderGatewayServiceStartHints } from "./shared.js";

describe("renderGatewayServiceStartHints", () => {
  it("uses systemctl --user by default on Linux", () => {
    if (process.platform !== "linux") return;
    const hints = renderGatewayServiceStartHints({} as NodeJS.ProcessEnv);
    expect(hints.some((hint) => hint.includes("systemctl --user"))).toBe(true);
  });

  it("uses systemctl for system scope on Linux", () => {
    if (process.platform !== "linux") return;
    const hints = renderGatewayServiceStartHints({
      CLAWDBOT_SYSTEMD_SCOPE: "system",
    } as NodeJS.ProcessEnv);
    expect(hints[0]).toContain("clawdbot daemon install --system");
    expect(hints.some((hint) => hint.includes("systemctl start"))).toBe(true);
    expect(hints.some((hint) => hint.includes("--user"))).toBe(false);
  });
});
