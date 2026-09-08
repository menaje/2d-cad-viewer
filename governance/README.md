# Governed Documents

This repository owns a small Document Catalog for its product/package boundary,
architecture decisions, distribution policy and selected normative contracts.
It complements existing compatibility manifests and does not replace them or
catalog every document.

`governed-documents.json` is author-maintained. Generated catalog and public
export bytes are derived from one exact source commit.

```sh
pnpm run generate:documents -- <40-hex-source-revision>
pnpm run check:documents
```

The [adoption environment](adoption.md) and [inventory](environment.json) keep
version observations, stage authority and tracked HOLDs separate. Start with
`pnpm run check:governance`, `pnpm run test:governance` and
`pnpm run check:public-surface`; document generation remains pinned to an exact
committed source revision. These checks confer no product or release authority.
