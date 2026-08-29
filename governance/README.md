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
