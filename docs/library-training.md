# Library training

TreeAI maps one Open WebUI Knowledge Base to one immutable training library. Files remain available to Open WebUI for retrieval while the library bridge copies accepted revisions into training object storage. A training cycle freezes exact revisions, normalizes them, creates completion-pretraining JSONL, trains a QLoRA adapter, and returns the factory to inference mode.

## Supported inputs

Each uploaded file is limited to 100 MiB. Markdown, plain text, JSON/JSONL, XML, YAML, TOML, INI, SQL, and common source-code files use direct normalization. PDF, DOCX, PPTX, and HTML use Marker during factory sleep mode. Archives, encrypted documents, spreadsheets, notebooks, standalone images, audio, and video are rejected in this release.

TreeAI detects content from file signatures and container structure. A mismatched extension or high-confidence credential/private-key match quarantines the revision. Moving or renaming a file changes its library relationship without duplicating its content-addressed object. Deletion excludes it from future snapshots but does not alter earlier snapshots.

## Collection size

The authoritative measurement is the usable token count reported after normalization, not uploaded byte size.

- A `smoke` run requires at least one ready document and 4,096 usable tokens. It runs no more than 16 optimizer steps and produces an inactive adapter only. For a dependable first pipeline test, use 8,000–25,000 tokens across at least two related files. For ordinary English or Markdown this is often roughly 35–125 KiB of normalized text, but PDFs can be much larger on disk.
- A `standard` run requires at least three ready source documents and 100,000 usable tokens, including at least 10,000 held-out tokens selected by whole-document hash. For the first meaningful training test, use 250,000–500,000 related tokens across 10–30 documents. That is commonly around 1–3 MiB of normalized English text. A stronger subject library will usually contain 500,000–2,000,000 focused tokens.

Keep each library topically coherent. Its directory tree becomes topic-path context in the dataset, so descriptive filenames, headings, and folders are more valuable than a larger mixture of unrelated material.

Qwen 3.5 currently runs with Axolotl sample packing disabled because the upstream 0.18 packing monkeypatch is incompatible with the pinned 4B decoder. Prepared records still carry explicit EOS document boundaries, and the deterministic builder keeps documents and coherent sections separate.

## Operator flow

Upload files into an Open WebUI Knowledge Base and attach exactly one Knowledge Base to the current chat. The managed **Train Library** action shows ready, pending, rejected, and estimated-token counts before confirmation. Choose `smoke` to qualify document processing and QLoRA mechanics, or `standard` for an evaluation- and promotion-eligible run.

The equivalent CLI flow is:

```text
treeai lab libraries
treeai training library documents <library-id>
treeai training library retry <library-id> <document-id>
treeai lab library train <library-id> --mode smoke
treeai lab library watch <run-id>
```

Normal inspection and monitoring do not require root for members of `treeseed-ai-operators`. Host mutation and recovery commands remain root-only.
