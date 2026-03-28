# Dev Vault Guide

This vault is for testing `Semantic Auto-Linker` without touching your real notes.

## How to use it

1. Open the `dev-vault` folder as an Obsidian vault.
2. Enable community plugins if Obsidian prompts you.
3. Confirm that `Semantic Auto-Linker` is enabled.
4. Run `Semantic Auto-Linker: Open control panel`.
5. Use the right sidebar panel to run note-level and whole-vault analysis.
6. Open `Current Note.md`.
7. Run `Semantic Auto-Linker: Analyze current note for safe links`.
8. Review the suggested links before applying them.
9. Open `Selection Playground.md` and test `Semantic Auto-Linker: Auto-link current selection`.
10. Run `Semantic Auto-Linker: Analyze whole vault for safe links` and inspect the graph-impact preview counts.
11. Run `Semantic Auto-Linker: Show graph preview` or use the panel button after vault analysis.
12. Compare the left and right graphs: the right side should show projected new links using the same node layout.
13. Run `Semantic Auto-Linker: Insert or update See also footer` on `Current Note.md`.

## Realistic areas

- `Projects/Auto-Linker/`: product and shipping notes with cross references
- `Projects/Graph Research/`: PCA and t-SNE exploration notes
- `Research/ML/`: embeddings and local inference notes
- `Research/Knowledge Systems/`: PKM and architecture notes
- `Hobbies/Tennis/`: sports technique and match-prep notes
- `Hobbies/Tabletop/`: Dungeons & Dragons and campaign-design notes
- `Semantic Playground/`: notes that avoid exact title overlap and are meant for future embedding-powered retrieval
- `People/`: collaborator-style pages with aliases
- `Meetings/`: note titles with dates and realistic prose
- `Operations/`: testing and maintenance notes
- `Daily/` and `Ideas/`: lightweight notes that create realistic graph texture

## Expected checks

- Heading text should not be linked.
- Frontmatter should not be touched.
- Existing `[[Knowledge Graph]]` links should prevent duplicate target suggestions.
- Inline code and fenced code should stay unchanged.
- Only one `Neural Networks` suggestion should appear even though both `Neural Networks` and `NN` are present.
- Whole-vault review should show projected link counts before and after apply.
- Graph preview should show current edges on the left and projected edges on the right.
- `See also` should add related notes once and update in place on rerun.
- The `Semantic Playground/` notes should mostly fail today in deterministic review because semantic retrieval is not merged yet.
- Once semantic retrieval exists, those same notes should become the acceptance set for embedding-powered suggestions.

## Fixture notes

- `Current Note.md`: whole-note review test
- `Selection Playground.md`: selection-only review test
- `Semantic Challenge Note.md`: semantic stress test with paraphrases instead of direct title matches
- `Hobbies/Tennis/`: distinct sports vocabulary cluster for embedding-space separation
- `Hobbies/Tabletop/`: distinct tabletop storytelling cluster for embedding-space separation
- `Ideas/Hobby Systems.md`: soft bridge note between different non-AI clusters
- `Semantic Playground/`: cluster of notes designed for embedding-only neighborhood checks
- `Semantic Playground/_Semantic Benchmark Map.md`: explicit semantic target pairs that should fail now and pass later
- `Neural Networks.md`: alias fixture (`NN`)
- `C++ Primer.md`: punctuation-heavy title fixture
- `Templates/Template Note.md`: excluded-folder style content sample
- `Archive/Old Concept.md`: archived content sample
