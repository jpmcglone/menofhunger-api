import {
  prepareXPlan,
  xSourceHash,
  type XPublishingSource,
  type XPublishingInput,
} from "./x-publishing-plan";
const policy = {
  enabled: true,
  accountIds: ["123"],
  quoteAccountIds: [],
  longAccountIds: [],
  editAccountIds: ["123"],
  postMaxMicros: 15000,
  mediaMaxMicros: 5000,
  priceVersion: "fixture",
};
const source = (): XPublishingSource => ({
  body: "Hello",
  media: [],
  poll: null,
});
function plan(s = source(), parts = ["Hello"]): XPublishingInput {
  return {
    parts,
    sourceHash: xSourceHash(s),
    replyToId: null,
    quoteId: null,
    edit: false,
  };
}
describe("explicit X publication plans", () => {
  it("counts every thread publication and funds all link-thread parts from the shared expensive allowance", () => {
    const s = source();
    expect(
      prepareXPlan(s, plan(s, ["one", "https://example.com"]), policy, "123"),
    ).toMatchObject({
      publications: 2,
      maximumMicros: 215000,
      bucket: "expensive",
    });
  });
  it("never silently splits, truncates or drops unsupported attachments", () => {
    const s = source();
    expect(() =>
      prepareXPlan(s, plan(s, ["x".repeat(281)]), policy, "123"),
    ).toThrow("explicit thread");
    s.media = [
      {
        id: "video",
        kind: "video",
        source: "upload",
        r2Key: "owned.mp4",
        deletedAt: null,
        alt: null,
      },
      {
        id: "photo",
        kind: "image",
        source: "upload",
        r2Key: "owned.jpg",
        deletedAt: null,
        alt: null,
      },
    ];
    expect(() => prepareXPlan(s, plan(s), policy, "123")).toThrow("one video");
  });
  it("gates Enterprise quotes, account long text and changed source snapshots", () => {
    const s = source();
    expect(() =>
      prepareXPlan(s, { ...plan(s), quoteId: "987" }, policy, "123"),
    ).toThrow("Enterprise");
    expect(
      prepareXPlan(
        s,
        plan(s, ["x".repeat(281)]),
        { ...policy, longAccountIds: ["123"] },
        "123",
      ).publications,
    ).toBe(1);
    expect(() =>
      prepareXPlan({ ...s, body: "changed" }, plan(s), policy, "123"),
    ).toThrow("source changed");
  });
  it("copies compatible poll options and remaining lifetime without inheriting MOH votes", () => {
    const s = source();
    s.poll = {
      endsAt: new Date(Date.now() + 3600000),
      options: [
        { text: "Faith", imageR2Key: null },
        { text: "Family", imageR2Key: null },
      ],
    };
    expect(prepareXPlan(s, plan(s), policy, "123").poll).toMatchObject({
      options: ["Faith", "Family"],
    });
    s.poll.options[0].text = "x".repeat(26);
    expect(() => prepareXPlan(s, plan(s), policy, "123")).toThrow(
      "25 characters",
    );
  });
  it("uses no publication slot for an explicitly supported native edit", () => {
    const s = source();
    expect(
      prepareXPlan(s, { ...plan(s), edit: true }, policy, "123", "987")
        .publications,
    ).toBe(0);
    expect(() =>
      prepareXPlan(
        s,
        { ...plan(s, ["a", "b"]), edit: true },
        policy,
        "123",
        "987",
      ),
    ).toThrow("edited in place");
  });
});
