import index from "./index.ts";

if (typeof index !== "function") {
  console.error("FAIL: default export is not a function");
  process.exit(1);
}
console.log("OK: index.ts loads; typebox + local imports resolve; default export is a function");
