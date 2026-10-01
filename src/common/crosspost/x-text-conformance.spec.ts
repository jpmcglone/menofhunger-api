import { readFileSync } from "fs";
import { join } from "path";
const vectors: Array<{
  description: string;
  text: string;
  weightedLength: number;
}> = JSON.parse(
  readFileSync(
    join(__dirname, "../../../test/fixtures/x-text-v3.json"),
    "utf8",
  ),
);
import { xWeightedLength } from "./crosspost-eligibility";
describe("official twitter-text v3 conformance", () => {
  it.each(vectors)("$description", ({ text, weightedLength }) =>
    expect(xWeightedLength(text)).toBe(weightedLength),
  );
});
