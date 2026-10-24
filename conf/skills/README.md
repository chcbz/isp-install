# Generic archive maintenance package

Candidate: **1.1.1**, prepared only. This folder does not register/approve/install a production skill.
The exact package SHA-256 and manifest SHA-256 are in `archive-maintenance-1.1.1-package.json`.
Rebuild with `python3 package-archive-maintenance.py`; different bytes at a versioned ZIP are refused.

- 1.1.0 is retained byte-for-byte as a failed preparation record: its SKILL.md top-level version did not satisfy the installer's required metadata.version. Do not approve/install it.
- 1.1.1 corrects that identity metadata, with a new immutable version/hash. Book text is never bundled.
- The package implements the native archive source/result contract, not a generic shell/URL importer. UTF-8 Chinese/Markdown headings and optional preface are supported; source/body hashes are deterministic.
- The host executes the measured installed local script without Runtime credentials/provider keys. Backend job/position/resource grants own all write/publish decisions.
- Preparation, reviewed package-catalog registration, installation receipt, runtime execution and publication are distinct gates. Tests use an isolated test-only approved row and no marketplace order.
- Production registration must use the existing reviewed package/catalog workflow and content-addressed package store. No direct production SQL, credential or automatic activation is included here.
