---
tags:
  - semantic
  - architecture
---

# Adapter Layer

The rest of the plugin should call one narrow interface and stay indifferent to where the numeric representations come from.
That indirection matters because the engine might live in a sidecar daemon today and a bundled runtime later.

This note is supposed to feel close to the backend-swapping architecture note without sharing its title language.

