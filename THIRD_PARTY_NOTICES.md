# Third-party components

Inbot's original code is licensed under the MIT License in `LICENSE`. Third-party components retain their own licenses. This notice does not replace their license texts or source-distribution requirements.

- Release archives include Node.js 24.21.0 with its upstream `runtime/LICENSE`, covering Node and its bundled components.
- Production JavaScript dependencies retain the license files supplied by their publishers under `application/node_modules`. Each archive includes a generated `licenses/` directory and `licenses/INDEX.md` recording exact package versions, declared licenses, and copied license and notice materials, including dependencies compiled into the owner UI and Email Worker.
- `better-sqlite3-multiple-ciphers` includes the MIT-licensed better-sqlite3 and SQLite3 Multiple Ciphers work and a target-specific native prebuild. Its upstream `LICENSE` is retained. SQLite itself is public domain.
- `@napi-rs/keyring` and its target-specific native prebuild are MIT-licensed. Their upstream license texts are included with the archive notices.
- `otpauth` 9.5.2 is MIT-licensed and provides TOTP parsing and code generation. Its upstream license is included with the archive notices.
- The owner UI bundles React, React DOM, TanStack Query, DOMPurify, and Tailwind CSS. Their notices and dependency notices are included in the archive's `licenses/` directory.
- `jschardet` is LGPL-2.1-or-later. Its unmodified JavaScript source and upstream license remain in `application/node_modules/jschardet`; Inbot does not prevent replacement of that library. `unpdf` includes an Apache-2.0-licensed PDF.js build with a supplemental upstream license.
- `cloudflared` is not included in the source repository or release archives. Enabling remote access explicitly downloads a pinned, checksum-verified connector from Cloudflare. It is a separate Apache-2.0-licensed component; see [its upstream license](https://github.com/cloudflare/cloudflared/blob/2026.9.1/LICENSE).

## Supplemental materials

The following license texts are maintained under `scripts/licenses` because the npm packages omit them or embed another project's code:

- [saxes 5.0.1](https://github.com/lddubeau/saxes/blob/v5.0.1/LICENSE), ISC with its upstream inherited notices
- [SQLite3 Multiple Ciphers 2.4.0](https://github.com/utelle/SQLite3MultipleCiphers/blob/v2.4.0/LICENSE), MIT, used by `better-sqlite3-multiple-ciphers` 13.0.3, plus copyright and license comment blocks from that npm archive's SQLite amalgamation for its embedded cryptographic and compression components; the supplemental notice records the source file's SHA-256
- [PDF.js 6.1.200](https://github.com/mozilla/pdf.js/blob/v6.1.200/LICENSE), Apache-2.0, embedded in `unpdf` 1.8.1
- [node-redis 6.3.0](https://github.com/redis/node-redis/blob/c3e8b53b0d9c97d05ca674f92a24a9ee91a50a0e/LICENSE), MIT, shared by `redis` and its `@redis/*` packages installed as Effect peers

`isarray` 1.0.0 supplies its complete MIT license in its README; that file is copied into the notices. Keyring platform packages share the license from the same-version `@napi-rs/keyring` package.

## Dependency license coverage

`exceljs` 4.4.0 uses `unzipper` 0.12.5 through a pinned pnpm override. This removes the old `binary`, `chainsaw`, and `buffers` dependencies whose npm archives omit license materials. The maintained `unzipper` package supplies its MIT license, which is copied into the archive notices. XLSX attachment extraction is covered by a synthetic workbook fixture test.

When changing dependencies or packaging, review the generated notice index and retain all applicable upstream license and notice files. Missing license declarations or materials fail packaging rather than silently omitting a notice.
