# Pi client SDK fork

Based on night-slayer18/leetcode-cli v3.5.2, commit
`282096f5c3952ae0e94a704adac344ec73c7732b`, Apache-2.0. Maintained changes are on
MaybeLL/leetcode-cli's `pi-sdk` branch. Original copyright/license are retained.

Changes: library entrypoint; separate send/check operations; bounded legacy
polling; sanitized job errors; optional failure statistics; complete example
input framing and metadata. CLI commands retain their public arguments.

`npm run build` produces the CLI plus `./client` export. `npm run build:sdk`
produces `build/client-package/`, a library-only installable package with just
got and Zod as dependencies. `npm pack ./build/client-package` creates a local
distribution; this is not an npm registry publication. SOURCE.json records the
exact fork revision and whether its tree was dirty. Release only clean builds.

SDK 3.5.2-pi.2 accepts LeetCode run IDs containing decimal timestamps (embedded
dots). The initial validator incorrectly treated these successful send responses
as missing IDs. Dot-only/traversal segments, slashes, queries and fragments remain
invalid. A regression checks send and check using the same dotted ID.

```ts
import { LeetCodeClient } from '@maybell/leetcode-client';
const client = new LeetCodeClient('leetcode.cn');
client.setCredentials({ session: '…', csrfToken: '…' });
const job = await client.startRun({
  titleSlug: 'two-sum', questionId: '1', lang: 'golang',
  code: '…', testcases: '[3,3]\n6',
}, { signal });
// Persist job before checking. A new client can check the same stored job.
const status = await client.checkJob(job, { signal });
```

`startSubmit` has the same request except for testcases. A Job includes id and
kind; each check performs at most one request and returns pending or complete.
The caller owns persistence, account/site isolation, polling intervals and total
deadline. Create a separate client per site/account; do not share credentials
across site switches. The optional constructor transport is a Got instance for
controlled integrations/tests; default uses official site endpoints.

Job requests do not retry or follow redirects. Cancellation before sending is
known unsent; interruption after sending may be outcomeUnknown. Never resend an
unknown operation automatically. Stopping checks does not cancel a remote job.
ClientError contains a safe category/message and no HTTP cause or credentials.
Read APIs retain upstream errors; adapters must sanitize them before display.

Optional statistics remain absent on error verdicts. Unknown judge states or
status codes are protocol errors, never assumed Accepted. Legacy convenience
methods start once and use checkJob with a 30-second polling deadline. They
include the job ID in timeout messages so callers can check without resending.

SDK imports do not load CLI, storage, keychain, editor, collaboration or user
configuration. Tests use fake or local HTTP only. Actual account judging is a
separate acceptance step, not proven by these tests.
