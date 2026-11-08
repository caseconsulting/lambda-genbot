# Code review feedback: stability-core series

This file is an example of a review-and-fix loop with [Claude Code](https://claude.com/claude-code).

1. **Review:** The `/code-review` skill ran in Claude Code against the stability-core series (`3e35a16..51256d5`, commits dc72223 → 51256d5). That series had already been merged, deployed and verified. The skill reported the 10 findings below, ranked most severe first. Separately, `sam validate --lint` was run and its warnings were added.
2. **Document:** Claude Code wrote the findings to this file, with a recommended change for each.
3. **Fix:** Claude Code implemented every recommendation, then updated this file to record what was actually done.

**Line numbers:** each _Found at_ reference points to commit `51256d5`, the code that was reviewed. Each _Resolution_ links to the current code.

Nothing here broke the happy path. The findings are edge-case robustness fixes and cleanups.

**Verification after the fixes:**

- `npm test`: 31 tests pass (up from 23). New tests cover each behaviour change.
- `sam validate --lint`: clean, where it previously failed with 3 warnings.
- Change-set preview (`--no-execute-changeset`): caught a log-group replacement that would have failed the deploy. That part was reverted; see [`sam validate --lint`](#sam-validate---lint).
- `sam build`: each function artifact now contains only the runtime files.
- **Not yet deployed.** The fixes need `npm run deploy` and the same live verification as the original series. See [Deploying these changes](#deploying-these-changes).

---

## 1. Bedrock call has no timeout and uses default retries

_Found at:_ `generate.js:9`, `generate.js:80` (51256d5)

The function's `Timeout` is 30s, and the HTTP API integration also times out at 30s. The Bedrock client used the SDK defaults: 3 attempts with backoff and no request timeout. A slow attempt (PLAN.md measured 3.6–7.2s normally) plus a throttle retry could use up the whole budget. If that happened, the Lambda timed out, Basecamp got a 500/503 from API Gateway, and the friendly fallback reply in the `catch` never ran.

**Resolution:** Bedrock is now bounded both per attempt and overall.

- [generate.js:14-18](generate.js#L14-L18): the client uses `maxAttempts: 2` with `connectionTimeout: 3000` and `requestTimeout: 20000`.
- [generate.js:94](generate.js#L94): `invokeModel` takes a `timeoutMs` and passes `abortSignal: AbortSignal.timeout(timeoutMs)`.
- [generate.js:185](generate.js#L185): the handler passes the invocation's remaining time minus `SAVE_BUDGET_MS` ([generate.js:22](generate.js#L22), 5s). That leaves time to save the image or return the fallback message.

---

## 2. Body parsing runs outside try/catch

_Found at:_ `generate.js:147-149` (51256d5)

`JSON.parse(event.body)` and `body.creator.company.id` threw on an empty body, invalid JSON or a missing `creator`. The endpoint is a public HTTP API, so anyone could send such a request. The result was an opaque 500 and an unhandled error in the logs.

**Resolution:** [generate.js:159-167](generate.js#L159-L167)

- A missing or invalid JSON body now returns `400 Bad Request`.
- Fields are read with optional chaining, so a body with no `creator` falls through to the company-ID gate and gets `403`.

---

## 3. Company-ID gate uses loose equality

_Found at:_ `generate.js:151` (51256d5)

With `==`, `null == undefined` is true. If the `companyId` env var were ever missing, a body with `creator.company.id: null` would pass the gate and spend Bedrock money. Type coercion has no place in an access check.

**Resolution:** [generate.js:170-174](generate.js#L170-L174). The gate denies the request when the env var is unset or the provided ID is `null`/`undefined`. Otherwise it compares `String(companyId) === expectedCompanyId`, so a numeric ID from Basecamp still matches.

---

## 4. Prompt is not validated

_Found at:_ `generate.js:44-47` (51256d5)

A missing or empty `command` produced `"undefined, anime style"` or `", anime style"`, which cost about $0.04 for a meaningless image. Core's 10,000-character prompt limit could also be exceeded once the style suffix was appended. Bedrock then returned a ValidationException, which was logged as a generic failure.

**Resolution:**

- [generate.js:176-182](generate.js#L176-L182): the prompt is trimmed. A missing, blank or non-string `command` gets a "Please include a description…" reply without calling AWS.
- [generate.js:44-47](generate.js#L44-L47): `MAX_PROMPT_LENGTH` is derived from the 10,000-character limit minus the longest `", <style> style"` suffix.
- [generate.js:60](generate.js#L60): `buildPayload` truncates to that length, so every style stays within the limit. A test checks this for each style.

---

## 5. Error log drops the error type and request ID

_Found at:_ `generate.js:163` (51256d5)

Logging only `error.message` made ThrottlingException, ValidationException and AccessDeniedException impossible to tell apart. It also dropped the AWS request ID, which matters for open item #2 in PLAN.md (verifying the content-filter path live).

**Resolution:** [generate.js:192](generate.js#L192) logs the whole error object (`console.error('Error generating image:', error)`), which includes the name, message, stack and `$metadata`.

---

## 6. `getContentType` duplicates what S3 already stores

_Found at:_ `retrieve.js:15-31`, `retrieve.js:90` (51256d5)

Every object is written with the correct `ContentType` (PNG for old images, JPEG for new), and `GetObject` returns it. The extension-to-type table was a second source of truth that had to be kept in sync, and any unexpected extension was silently served as JPEG.

**Resolution:**

- `CONTENT_TYPES` and `getContentType` were removed.
- [retrieve.js:29](retrieve.js#L29): `getImage` now returns `{ body, contentType }`, using the stored `response.ContentType` and falling back to `image/jpeg`.
- [retrieve.js:64-69](retrieve.js#L64-L69): the handler serves that content type.

---

## 7. S3 `CacheControl` is never used

_Found at:_ `generate.js:114` (51256d5)

Clients never read objects from S3 directly. Only `genbot-retrieve` reads them, and it sets its own `cache-control` header, so the value set on the S3 object had no effect on any client.

**Resolution:** `CacheControl` and the duplicate `IMMUTABLE_CACHE_CONTROL` were removed from the `PutObject` call at [generate.js:123-128](generate.js#L123-L128). The cache policy now lives only in retrieve.js ([retrieve.js:9](retrieve.js#L9)), which is where it is actually applied. The alternative, having retrieve forward the stored value, was not chosen because it would keep the policy in two places.

---

## 8. Constants duplicated across handlers

_Found at:_ `generate.js:14-15,166`, `retrieve.js:9-13` (51256d5)

`BUCKET_NAME`, `IMMUTABLE_CACHE_CONTROL` and the Giphy error URL were defined in both files. The series added `ERROR_IMAGE_URL` to retrieve.js, but generate.js still hard-coded the same URL inline.

**Resolution:**

- New [constants.js](constants.js) exports `REGION`, `BUCKET_NAME` and `ERROR_IMAGE_URL`, and both handlers import them ([generate.js:4](generate.js#L4), [retrieve.js:3](retrieve.js#L3)).
- The fallback reply uses `ERROR_IMAGE_URL` ([generate.js:193](generate.js#L193)).
- `BUCKET_NAME` is read from an env var set by `!Ref GenBotImagesBucket` ([template.yaml:56](template.yaml#L56), [template.yaml:103](template.yaml#L103)). The template is now the single source of truth for the bucket name. The literal default is kept only for local runs and tests.

---

## 9. Bedrock region and model ID hard-coded in two places

_Found at:_ `template.yaml:59`, `generate.js:8,12` (51256d5)

The IAM resource ARN and the code each named the model and region separately. Switching to the SD3.5 Large fallback in PLAN.md, or moving regions, needed two coordinated edits. If only the code changed, every request would fail with AccessDeniedException.

**Resolution:**

- [template.yaml:22-30](template.yaml#L22-L30): new `BedrockRegion` and `BedrockModelId` parameters (defaults `us-west-2` / `stability.stable-image-core-v1:1`).
- [template.yaml:68](template.yaml#L68): they build the IAM ARN with `!Sub`.
- [template.yaml:57-58](template.yaml#L57-L58): they are passed to the function as `bedrockRegion` / `modelId`.
- [generate.js:9-10](generate.js#L9-L10): the code reads them from those env vars, with the same defaults for local runs and tests.

To switch models, change one parameter, for example with `--parameter-overrides BedrockModelId=...`.

---

## 10. Tests and docs are shipped in both Lambda artifacts

_Found at:_ `template.yaml:42,92` (51256d5)

`CodeUri: ./` had no exclusions. `.aws-sam/build/GenBotFunction/` contained `test/`, `PLAN.md`, `README.md`, `event-*.json` and `template.yaml`. That made the artifacts larger, and they are unzipped on each cold start (which PLAN.md says happens on nearly every request).

**Resolution:** [package.json:7-11](package.json#L7-L11) adds a `"files": ["generate.js", "retrieve.js", "constants.js"]` allow-list, which `sam build` honours. Each build directory now contains only the three handler files, `node_modules`, `package.json`, `package-lock.json` and `README.md` (npm always includes the README). This was chosen over moving the handlers to `src/` because it changes no paths or test imports.

**Follow-up found before deploying:** the deployed package was worse than the review assumed. The `deploy` script passed `--template-file template.yaml`, so `sam deploy` zipped the project folder directly and never used the `.aws-sam/build` output. The live `genbot` package (10.6 MB) contained `.git/`, dotfiles, `test/`, `PLAN.md`, and a stale copy of `.aws-sam/` (~7,200 files), alongside `node_modules`. The `files` allow-list alone would not have changed that.

[package.json:16](package.json#L16) drops `--template-file template.yaml`. With no template file given, `sam deploy` uses the built template in `.aws-sam/build/`, so the allow-list now applies to what is deployed. The `.git/config` that was shipped contains only the SSH remote URL, with no credentials.

---

## `sam validate --lint`

At 51256d5:

```
W3005  'GenBotFunction' dependency already enforced by a 'Ref' at
       Resources/GenBotFunctionLogGroup/Properties/LogGroupName        (template.yaml:75)
W3005  'GenBotFunction' dependency already enforced by a 'Ref' at
       Resources/GenBotFunctionApiLogGroup/Properties/LogGroupName     (template.yaml:82)
W3005  'GenBotRetrieveFunction' dependency already enforced by a 'Ref' at
       Resources/GenBotRetrieveFunctionLogGroup/Properties/LogGroupName (template.yaml:113)
Error: Linting failed. At least one linting rule was matched to the provided template.
```

These warnings dated back to the initial commit and did no harm at deploy time: each `LogGroupName: !Sub .../${GenBotFunction}` already made CloudFormation create the function first. They still mattered because lint exited non-zero, which would fail any CI or pre-deploy step that runs it.

The review also flagged three related `DependsOn` problems that lint did not catch:

- **`GenBotFunction` → `GenBotRetrieveFunctionUrl`** (51256d5 line 39): redundant, because the `!GetAtt GenBotRetrieveFunctionUrl.FunctionUrl` env var already creates the dependency.
- **`GenBotImagesBucket`** (51256d5 lines 38, 89): needed only because both policies hard-coded the bucket ARN as a string.
- **Log group creation order:** the log groups are created _after_ the functions. If a function ran before its log group existed, Lambda would create the group itself, and on a fresh deploy the stack's `AWS::Logs::LogGroup` would fail with "already exists".

**Resolution:** all `DependsOn` blocks are gone from [template.yaml](template.yaml), and `sam validate --lint` reports `valid SAM Template`.

- **Bucket policies:** they reference the bucket resource (`!GetAtt GenBotImagesBucket.Arn`, [template.yaml:74](template.yaml#L74), [:114-115](template.yaml#L114-L115)), which creates the dependency implicitly. They keep the explicit least-privilege statements rather than switching to the broader SAM `S3WritePolicy`/`S3ReadPolicy` templates.
- **Log groups: tried, then reverted.** The first fix gave each log group a literal name (`/aws/lambda/genbot`, etc.) and pointed each function at it with `LoggingConfig`, so the group would be created first. The change-set preview marked all three log groups `Replacement: True`. Its details showed `RequiresRecreation: Always`, `Evaluation: Static` on `LogGroupName`, because CloudFormation compares template values as written: `!Sub /aws/lambda/${GenBotFunction}` → `/aws/lambda/genbot` counts as a rename, even though both resolve to the same string. CloudFormation can't replace a custom-named resource in place, so the deploy would have failed and rolled back. The log groups keep their original `!Sub` names ([template.yaml:84](template.yaml#L84), [:89](template.yaml#L89), [:119](template.yaml#L119)), with only the redundant `DependsOn` removed. The creation-order risk applies only to a brand-new stack and is accepted. Fixing it on this stack would mean retaining the log groups, removing them from the stack and re-importing them.

---

## Deploying these changes

Always review the change set before executing it. That is how the log group replacement described above was caught:

```sh
npm run build && sam deploy --region us-east-1 --capabilities CAPABILITY_IAM --s3-prefix lambda-genbot \
  --s3-bucket case-consulting-mgmt-sam-deployments --stack-name lambda-genbot --profile mgmt --no-execute-changeset
```

These are the same flags as `npm run deploy`, plus `--no-execute-changeset`.

In the change set, check:

- No resource shows `Replacement: True`, and the log groups are not in the change set at all. Use `aws cloudformation describe-change-set` to see the per-property reason for any change.
- `GenBotFunction` shows new env vars (`BUCKET_NAME`, `bedrockRegion`, `modelId`).

After deploying, confirm that the code size reported by `aws lambda get-function --function-name genbot` has dropped from about 10.6 MB.

Then repeat the live checks from PLAN.md: generate an image from Basecamp, and confirm the retrieve URL serves both a new JPEG and an older PNG with the correct content type.
