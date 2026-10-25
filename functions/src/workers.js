"use strict";

const DEPARTMENTS = new Set([
  "Log Yard", "Sawmill", "Saw Shop", "Workshop", "Charcoal",
  "Kindry", "Chainsaw", "Security", "Administration", "HR"
]);

function normalizeWorkerName(value) {
  return typeof value === "string"
    ? value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
    : "";
}

function validateWorkerInput(input) {
  if (!input || typeof input !== "object") return { ok: false, reason: "Worker details are required." };
  const name = typeof input.name === "string" ? input.name.normalize("NFC").replace(/\s+/g, " ").trim() : "";
  const dept = typeof input.dept === "string" ? input.dept.trim() : "";
  const type = typeof input.type === "string" ? input.type.trim().toLowerCase() : "casual";
  const staffId = typeof input.staffId === "string" ? input.staffId.trim().slice(0, 100) : "";
  if (name.length < 2 || name.length > 100) return { ok: false, reason: "Worker name must be 2–100 characters." };
  if (!DEPARTMENTS.has(dept)) return { ok: false, reason: "Choose a valid department." };
  if (!["casual", "permanent"].includes(type)) return { ok: false, reason: "Worker type must be casual or permanent." };
  return { ok: true, worker: { name, nameKey: normalizeWorkerName(name), dept, type, staffId } };
}

module.exports = { DEPARTMENTS, normalizeWorkerName, validateWorkerInput };
