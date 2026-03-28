---
tags:
  - semantic
  - architecture
---

# Pluggable Backends

The caller should not care whether vectors come from a local daemon, a browser-loaded model, or some later provider.
This is mostly about keeping the integration layer swappable so the retrieval logic stays stable while the model source changes.

That language should sit close to the abstraction note and the local execution note.

