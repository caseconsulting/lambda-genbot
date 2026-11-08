# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm test` — run all unit tests (built-in `node:test`; all AWS calls are mocked, no credentials needed).
- `node --test test/generate.test.js` — run one test file; add `--test-name-pattern "<regex>"` to run a single test.
- `npm run build` — `sam build` into `.aws-sam/build`. `npm run clean` removes it.
- `npm run deploy` — build, then deploy the `lambda-genbot` stack to us-east-1 with the `mgmt` AWS SSO profile (`npm run login` first). Deploys go to production.
- `npm run local:generate` / `npm run local:retrieve` — `sam local invoke` with `event-*.json` (needs Docker). These hit **real** AWS: generate calls Bedrock (costs money) and writes to the production bucket.

There is no lint script. Style is defined in `.eslintrc.json` / `.prettierrc.json`: ES modules, 2-space indent, single quotes, semicolons, no trailing commas, 120-char lines.

## Architecture

Two Lambda functions (Node.js 24, ESM) defined in `template.yaml`, sharing `constants.js`:

- **genbot** (`generate.js`) — behind an API Gateway HTTP API (`POST /`), called by a Basecamp chatbot command. Rejects non-JSON bodies (400), checks `creator.company.id` against the `companyId` env var (resolved from SSM `/Basecamp/CompanyID`; 403 otherwise), appends a random style from `STYLES` to the prompt, calls Bedrock Stable Image Core in **us-west-2** (the model is only offered in-region there), saves `<requestId>.jpg` to S3 in **us-east-1**, and replies with plain text: the genbot-retrieve URL + file name. Generation/save failures still return HTTP 200 with a "Something went wrong" message + `ERROR_IMAGE_URL`, because Basecamp displays the body.
- **genbot-retrieve** (`retrieve.js`) — a Lambda Function URL (no auth). Reads the key from the request path, returns the image Base64-encoded with the content type stored on the S3 object (older images are PNG, newer JPEG) and immutable cache headers. Any error → 303 redirect to `ERROR_IMAGE_URL` with `no-store`.

Constraints that span files:

- **Timeout budget:** the HTTP API/Lambda timeout is 30s. `handler` passes `getRemainingTimeInMillis() - SAVE_BUDGET_MS` as an abort timeout to Bedrock, and the Bedrock client is limited to 2 attempts with connection/request timeouts, so there's always time left to reply with the error message.
- **Bucket name is duplicated on purpose** in `constants.js` and `template.yaml`. Passing it via `!Ref` as an env var breaks `sam local` (it resolves `!Ref` to the logical ID). Keep both in sync.
- **Bedrock region and model ID** come from template parameters (`BedrockRegion`, `BedrockModelId`), which also scope the IAM policy; `generate.js` reads them from env vars with defaults for local runs/tests.
- **Stable Image Core rejects `style_preset`**, so the style goes into the prompt text, and the prompt is truncated to `MAX_PROMPT_LENGTH` so the styled prompt fits the model's 10,000-char limit.
- **Packaging:** the `files` allow-list in `package.json` controls what `sam build` puts in each function. Add new runtime modules there. `deploy` must deploy the `sam build` output (not `--template-file template.yaml`, which zips the whole repo including `.git`).
- **Log groups** use `!Sub /aws/lambda/${GenBotFunction}`-style names. Don't change them to literal names: CloudFormation treats that as a rename and the deploy fails. Preview risky template changes with `sam deploy --no-execute-changeset` and `aws cloudformation describe-change-set`.
- **Local quirks:** `sam local` can't resolve `{{resolve:ssm:...}}` or the Function URL attribute, so locally `companyId` is the literal string `{{resolve:ssm:/Basecamp/CompanyID:1}}` (which `event-generate.json` sends) and the retrieve link in the reply is broken.

## Tests

Tests mock `BedrockRuntimeClient.prototype.send` and `S3Client.prototype.send` with `mock.method`, and set `process.env.companyId` / `retrieveApi` in `beforeEach`. Functions are exported individually (`buildPayload`, `invokeModel`, `saveImageToBucket`, `getImage`, `handler`) so they can be tested directly. `buildPayload` takes an injectable `random` function for deterministic style selection.

## Docs

`README.md` covers setup, AWS SSO, local runs, logs, and stack deletion. `PLAN.md` holds the model-migration design notes and open items. `FEEDBACK.md` records past review findings and why some fixes were reverted. Update the README when commands or behavior change.
