---
tags:
  - semantic
  - local-ai
---

# Notebooks Over APIs

For some vault workflows, the important choice is to keep the computation on the same machine as the notes rather than shipping text to a hosted service.
That tends to matter for privacy, latency, and offline use more than raw model size.

This should feel close to the note about running models beside the vault without sharing its exact title words.

*** Add File: C:\Users\yousi\OneDrive\Desktop\projects\semantic-auto-linker\dev-vault\Semantic Playground\_Semantic Benchmark Map.md
---
tags:
  - semantic
  - benchmark
---

# Semantic Benchmark Map

These pairs are meant to be hard for deterministic matching and good for embedding-backed retrieval later.

- `Meaning As Coordinates` -> `Embeddings`, `Cosine Similarity`
- `Models That Learn Features` -> `Neural Networks`, `Machine Learning`
- `Notebooks Over APIs` -> `Local Inference`
- `Adapter Layer` -> `Provider Abstraction`
- `Digital Garden Pages` -> `Evergreen Notes`, `PKM`
- `Semantic Challenge Note` -> several of the targets above

Today:
- deterministic review should mostly miss these
- semantic index rebuild should still succeed if an embedding model exists

Future semantic acceptance:
- these notes should start surfacing the target notes above even without direct title overlap

