---
name: archive-maintenance
version: 1.1.0
description: Maintain any explicitly supplied UTF-8 book as data through the native archive job contract.
---
# 典籍维护

Accept an explicit backend job/source and the verified installed package. Parse UTF-8 chapter headings, paragraphs and an optional preface without inventing text or fetching URLs. The script consumes one JSON source snapshot on stdin and emits an immutable archive manifest with byte/hash metrics. Book names are data. It makes no network calls and receives no Runtime credentials.

Backend job permissions, source identity, DRAFT_ONLY/AUTO and current appointment are authoritative. Installation alone never authorizes publication. The host submits the deterministic result using its current native session and original job identity; lost responses are recovered from that job, not a replacement job. Report PUBLISHED only after the backend commits it. Never use a human OAuth token.
