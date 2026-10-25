#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

function summarize(filename) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    console.error("Could not read valid npm audit JSON at " + filename + ": " + error.message);
    process.exitCode = 1;
    return;
  }

  console.log("\n=== Dependency audit: " + filename + " ===");
  if (report.error) {
    console.log("Audit command reported an error: " + JSON.stringify(report.error));
    console.log("Re-run the audit when registry access is available.");
    return;
  }

  const counts = report.metadata?.vulnerabilities || {};
  console.log("Counts: " + JSON.stringify(counts));
  const entries = Object.entries(report.vulnerabilities || {});
  entries.sort((a, b) => {
    const rank = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
    return (rank[a[1].severity] ?? 5) - (rank[b[1].severity] ?? 5) || a[0].localeCompare(b[0]);
  });

  for (const [name, item] of entries) {
    const advisories = (item.via || []).map(v => {
      if (typeof v === "string") return v;
      return [v.title || v.name || "advisory", v.url || ""].filter(Boolean).join(" ");
    }).join("; ");
    console.log(
      "- " + name +
      " | severity=" + item.severity +
      " | direct=" + Boolean(item.isDirect) +
      " | affected=" + (item.range || "not supplied") +
      " | fix=" + JSON.stringify(item.fixAvailable) +
      " | advisories=" + advisories
    );
  }
}

if (process.argv.length < 3) {
  console.error("Usage: node scripts/summarize-npm-audit.cjs <audit-json> [more-json-files...]");
  process.exit(2);
}

for (const filename of process.argv.slice(2)) summarize(filename);
