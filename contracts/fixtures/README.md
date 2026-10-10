# API contract fixtures

These synthetic responses describe platform-neutral API contracts. They are test
data, not production configuration or alternate endpoint behavior.

Domain files (`auth`, `posts`, `follows`, `checkins`, `groups`, `messages`, and
`notifications`) are generated from the DTO-checked examples in
`src/common/dto/api-response-fixtures.ts`. Any client can consume them.
`release.json` retains the existing billing, deletion, and Marvin fixture bundle
used by web and iOS.

Generate with `npm run sync:contract-fixtures -- --ios-root <checkout> --android-root <checkout>`.
Use the same options with `--check` to detect drift.
Generated client copies must match the API files exactly; edit their TypeScript
source instead of the JSON. Keep client-specific UI scenarios, loading/error
behavior, and mock repositories in their respective client repositories.
