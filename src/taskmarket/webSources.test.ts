import { readFileSync } from "node:fs";
import { inputs } from "./bradbury.js";
import { taskDescription, matchesTaskDescription } from "./description.js";
import { agreementSchema, newAgreementSchema, type Job } from "./model.js";
import { describe, expect, it } from "vitest";
import { webDomains, webSources } from "./webSources.js";

const host = "docs.genlayer.com";
describe("milestone web evidence", () => {
  it("collects distinct approved pages from Markdown and plain text", () => {
    const { urls } = webSources([host], [
      "[Receipt](https://docs.genlayer.com/a_(b)). Another https://DOCS.genlayer.com/a_(b)#paid",
      "https://other.org/links https://docs.genlayer.com:8443/page https://me@docs.genlayer.com/hidden",
      "| https://docs.genlayer.com/b |",
    ]);
    expect(urls).toEqual(["https://docs.genlayer.com/a_(b)", "https://docs.genlayer.com/b"]);
  });
  it("preserves an overflow signal so no subset can release funds", () => {
    expect(webSources([host], [Array.from({length: 10}, (_, n) => `https://${host}/${n}`).join(" ")]).urls).toHaveLength(4);
  });
  it("requires exact public hostnames", () => {
    for (const name of ["localhost", "127.0.0.1", "*.org", "foo.internal", "https://docs.genlayer.com"])
      expect(webDomains.safeParse([name]).success).toBe(false);
    expect(webDomains.parse([host])).toEqual([host]);
  });
});

it("keeps historic jury inputs intact and binds new citations to the posted agreement", () => {
  const job: Job = JSON.parse(readFileSync("examples/taskmarket/settled-pilot.json", "utf8"));
  const judgment = job.judgments[0];
  const oldDescription = taskDescription(job.agreement);
  expect(JSON.parse(inputs(job, judgment)[3])).not.toHaveProperty("web");
  const milestone = job.agreement.milestones[0];
  milestone.webDomains = [host];
  milestone.rubric += " See https://docs.genlayer.com/receipt.";
  job.evidence!.files[0].text += " [Source](https://docs.genlayer.com/file).";
  const approved = agreementSchema.parse(job.agreement);
  expect(matchesTaskDescription(oldDescription, approved)).toBe(false);
  expect(taskDescription(approved)).toContain(host);
  expect(matchesTaskDescription(taskDescription(approved), approved)).toBe(true);
  expect(JSON.parse(inputs(job, judgment)[3]).web).toEqual({
    domains: [host], urls: ["https://docs.genlayer.com/receipt", "https://docs.genlayer.com/file"],
  });
});

it("pins binary rulings only in new agreements and keeps funded v1 inputs byte-compatible", () => {
  const job: Job = JSON.parse(readFileSync("examples/taskmarket/settled-pilot.json", "utf8"));
  expect(JSON.parse(inputs(job, job.judgments[0])[3])).not.toHaveProperty("decision_policy");
  expect(newAgreementSchema.safeParse(job.agreement).success).toBe(false);
  expect(agreementSchema.safeParse({ ...job.agreement, version: "genlayer-taskmarket/v2" }).success).toBe(false);
  job.agreement = newAgreementSchema.parse(JSON.parse(readFileSync("examples/taskmarket/fixed.json", "utf8")));
  expect(JSON.parse(inputs(job, job.judgments[0])[3]).decision_policy).toBe("pass-fail");
  expect(taskDescription(job.agreement)).toContain("fails at 0–69");
});

it("refuses a new rubric whose own citations already exceed the submission limit", () => {
  const agreement = JSON.parse(readFileSync("examples/taskmarket/web-evidence.json", "utf8"));
  const milestone = agreement.milestones[0];
  milestone.rubric = Array.from({ length:4 }, (_, i) => "https://" + milestone.webDomains[0] + "/" + i).join(" ");
  expect(newAgreementSchema.safeParse(agreement).success).toBe(false);
});
