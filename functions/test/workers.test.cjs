"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeWorkerName, validateWorkerInput } = require("../src/workers");

test("worker names normalize case, spaces and combining accents consistently", () => {
  assert.equal(normalizeWorkerName("  KOFI   Mensah "), "kofi mensah");
  assert.equal(normalizeWorkerName("José Osei"), "jose osei");
  assert.equal(normalizeWorkerName("JOSE\u0301 OSEI"), "jose osei");
});

test("worker validation requires a real name, department and valid worker type", () => {
  assert.equal(validateWorkerInput({name:"A",dept:"Log Yard",type:"casual"}).ok, false);
  assert.equal(validateWorkerInput({name:"Kofi Mensah",dept:"Unknown",type:"casual"}).ok, false);
  assert.equal(validateWorkerInput({name:"Kofi Mensah",dept:"Log Yard",type:"temporary"}).ok, false);
  assert.deepEqual(validateWorkerInput({name:"  Kofi   Mensah ",dept:"Log Yard",type:"Permanent",staffId:" Y-1 "}), {
    ok:true, worker:{name:"Kofi Mensah",nameKey:"kofi mensah",dept:"Log Yard",type:"permanent",staffId:"Y-1"}
  });
});
