# 37. Model cards pinned as served markdown

## Status

Accepted. Extends 0036's required host matrix as the model-guidance axis
source.

## Context

The model-guidance skill caches researched judgment per worker model
(`references/<model>.md`, hash-pinned in `model-selector.yaml`'s `research:`
map), but the primary source — the vendor's model/system card — was only
cited by URL. Vendor cards are PDF-first with two instability modes: stable
landing URLs whose content mutates silently, and content-addressed CDN PDF
paths that change per revision. A rotted URL loses the primary source
entirely, and nothing ties a model's `fresh` classification to having the
source material on hand. Candidate contracts differed on what a cached card
is (raw bytes vs converted markdown), what the drift gate hashes, whether
the gate parses card provenance, and whether cards are required for
freshness.

## Decision

Every model on the guidance axis carries a cached card at
`references/cards/<model>.md` — the vendor's card converted to markdown,
sitting BESIDE the research notes (the notes stay the distilled review
artifact; the card is raw source cache). Markdown only: no PDFs or binary
artifacts enter the tree. Each card opens with a first-comment provenance
header recording the durable discovery URL, the resolved artifact URL
actually fetched, the fetch date, the converter, and the vendor's copyright
notice is retained in the body — an internal-use cache held as tolerated
risk, not asserted fair-use right.

The `research:` map gains an optional nested `card: {reference, sha256}`
per model. The hash gates the COMMITTED MARKDOWN — "is this cache the
reviewed one" — never upstream bytes; upstream drift is a human-triggered
re-research concern (recorded validators like ETag are advisory), and CI
stays fully offline. The drift gate hashes every declared card and never
parses card headers: fetched vendor content is attacker-influenceable, so
presence + hash parity is all the gate consumes; headers are human- and
skill-facing only. Coercion is loud for a declared-but-partial card mapping
and for a card path equal to the notes path; an absent card key is simply
no card.

In the state lattice a card is REQUIRED for `fresh`: notes-researched with
parity but no card classifies as a `missing`-class gap (backfill — the
envelope's reasons field says `no-card`), a drifted card classifies `stale`,
and a never-researched model stays `stub` regardless of card. The skill's
research pass becomes research → fetch card → cache both → distill →
re-hash, with a card-only shortcut when the sole gap reason is a missing
card.

Rejected: hashing raw upstream bytes (every cosmetic vendor edit trips the
gate, and 200-page PDFs bloat history); parsing card provenance in the gate
(injection surface for fetched content); TTL-based freshness (re-research
stays human-triggered); making card fields required in coercion (existing
entries must load while backfill happens as inert data).

## Consequences

- The research map is a two-artifact lockfile per model; changes to it are
  a reviewed security boundary like any pin file.
- Card conversion quality depends on the fetch-time converter and is
  recorded, not gated — a converter change legitimately re-pins hashes.
- A model newly added to the host matrix surfaces as one `missing` gap
  covering notes and card together; the committed tree ships all-fresh
  because the current axis's cards are backfilled as inert data before the
  lattice starts requiring them.
