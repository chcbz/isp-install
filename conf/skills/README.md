# Skill packages

## CYF archive maintenance native package (2026-11-05)

`archive-maintenance/` is the **2.0.0 INSTRUCTION** package: SKILL.md plus the existing deterministic UTF-8 parser. It contains no legacy execution manifest and does not activate the old archive-job reconciler. Native execution still requires actual tools and API authorization; package installation is not evidence of a published book.

Source `6b7035038b7e4af8a86d449df66d3587ceeef7f0`, Flow `5264702/152`: six focused tests passed and the skill-only ZIP was produced/uploaded on the worker. SHA-256 `d272bc3f1bd24fb215e1f23323ceb985a16cf3f756029ff0ca196a083e8f31a2`. No Runtime application build or restart was needed.

CYF's authorized owner published the package through the normal reviewed publication API, linked it to the “典籍管理” position, and appointed 吴用. The position installation completed; profile and real UI show “典籍维护” installed/ready. This does **not** establish archive conversation tools or 《三国演义》 publication. Operational evidence: CYF `docs/implementation/handoffs/ARCHIVE-MANAGEMENT-CHAT-20261105.md`.

## Historical executable preparations (not the current install path)

Candidate: **1.1.1**, prepared only. This folder does not register/approve/install a production skill.
The exact package SHA-256 and manifest SHA-256 are in `archive-maintenance-1.1.1-package.json`.
Rebuild with `python3 package-archive-maintenance.py`; different bytes at a versioned ZIP are refused.

- 1.1.0 is retained byte-for-byte as a failed preparation record: its SKILL.md top-level version did not satisfy the installer's required metadata.version. Do not approve/install it.
- 1.1.1 corrects that identity metadata, with a new immutable version/hash. Book text is never bundled.
- The package implements the native archive source/result contract, not a generic shell/URL importer. UTF-8 Chinese/Markdown headings and optional preface are supported; source/body hashes are deterministic.
- The host executes the measured installed local script without Runtime credentials/provider keys. Backend job/position/resource grants own all write/publish decisions.
- Preparation, reviewed package-catalog registration, installation receipt, runtime execution and publication are distinct gates. Tests use an isolated test-only approved row and no marketplace order.
- Production registration must use the existing reviewed package/catalog workflow and content-addressed package store. No direct production SQL, credential or automatic activation is included here.
