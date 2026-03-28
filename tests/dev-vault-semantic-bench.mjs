import { performance } from "node:perf_hooks";
import { createDevVaultHarness } from "./dev-vault-harness.mjs";

const harness = await createDevVaultHarness();

const challengeColdStart = performance.now();
await harness.analyzeNote("Semantic Challenge Note.md");
const challengeColdMs = performance.now() - challengeColdStart;

const challengeWarmStart = performance.now();
await harness.analyzeNote("Semantic Challenge Note.md");
const challengeWarmMs = performance.now() - challengeWarmStart;

const vaultColdStart = performance.now();
const vaultCold = await harness.analyzeWholeVault();
const vaultColdMs = performance.now() - vaultColdStart;

const vaultWarmStart = performance.now();
const vaultWarm = await harness.analyzeWholeVault();
const vaultWarmMs = performance.now() - vaultWarmStart;

console.log(`Challenge note suggestions: ${vaultCold.results.find((result) => result.file.path === "Semantic Challenge Note.md")?.suggestions.length ?? 0}`);
console.log(`Challenge note cold=${challengeColdMs.toFixed(1)}ms warm=${challengeWarmMs.toFixed(1)}ms`);
console.log(`Whole vault cold=${vaultColdMs.toFixed(1)}ms warm=${vaultWarmMs.toFixed(1)}ms`);
console.log(`Whole vault suggestions cold=${vaultCold.totalSuggestions} warm=${vaultWarm.totalSuggestions}`);
