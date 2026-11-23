import { describe, expect, it } from "vitest";
import { zoomBindings } from "./zoom";

describe("zoom shortcuts", () => {
  it("binds every configured key to its zoom step", () => {
    const steps: number[] = [];
    const bindings = zoomBindings({ zoom_in: ["Ctrl-=", "Ctrl-+"], zoom_out: ["Ctrl--"], zoom_reset: ["Ctrl-0"] }, (s) => steps.push(s));
    expect(bindings.map((b) => b.key)).toEqual(["Ctrl-=", "Ctrl-+", "Ctrl--", "Ctrl-0"]);
    for (const binding of bindings) binding.run!(null as never);
    expect(steps).toEqual([1, 1, -1, 0]);
  });
});
