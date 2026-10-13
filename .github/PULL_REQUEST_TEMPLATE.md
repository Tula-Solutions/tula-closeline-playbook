<!-- Fill every section from the actual diff. Delete a section only if it genuinely does not apply. -->

## 📝 Summary

<!-- What this PR does and why. Link the issue: Tula-Solutions/tula-closeline#<n>. -->

## 🔨 What changed

-

## 🧩 Structure

- [ ] Modules follow `router.ts` / `service.ts` / `schema.ts`; adapters are built only in `container.ts`
- [ ] Anything outside the process goes through a port with a memory adapter
- [ ] Tenant tables carry `organization_id`, are covered by row-level security, and have a cross-Organization test
- [ ] Shared libraries are pinned to a tag; a library change ships its rebuilt `dist/`

## ⚡ Performance and scale

- [ ] No unbounded query; lists are cursor-paginated with a maximum page size
- [ ] Every outbound call has a timeout and bounded retry; retried handlers are idempotent
- [ ] Hot path touched? Expected complexity: <!-- e.g. O(log n) per lookup --> and benchmark added or updated in `bench/`

## 🧪 Testing

- [ ] `bun run verify` passes locally
- [ ] Regression test added for every bug fixed or review finding addressed
- [ ] Not run or not verified (be specific):

## 🦦 Ollie review

<!-- Final verdict from /review-loop, plus findings fixed / dismissed (with evidence) / deferred (issue link). -->

## 🔐 Security impact

<!-- Tokens, tenant isolation, Contact Consent, disclosure, recordings or personal data touched? Write "None" if not. -->

## 💥 Breaking changes

<!-- Contract or schema changes consumers must adapt to, and the tag that carries them, or "None". -->
