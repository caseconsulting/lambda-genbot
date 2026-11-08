# PLAN: genbot model upgrade and latency improvements

**Status: complete.** Deployed and verified in Basecamp on 2026-11-08. Local notes only (`PLAN.md` is in `.gitignore`).

## Summary

| | Before | After |
|---|---|---|
| Model | Stable Image Style Guide (image-to-image, needed CASE logo as starter image) | **Stable Image Core** (text-to-image, no starter image) |
| Bedrock region | us-east-1 (`us.` geo inference profile) | **us-west-2** (Core is in-region there only) |
| Image | ~1.1 MB PNG | **~0.6 MB JPEG**, 1536×1536 |
| Command → image fetched by Basecamp | **~13.3 s** | **~5.4–7.4 s** |
| Price per image | $0.07 (AWS pricing page) | ~$0.04 (third-party; confirm on the bill) |

Changes shipped: `generate.js`, `retrieve.js`, `template.yaml` (IAM for Core in us-west-2, `accountId` env var removed, retrieve memory 256 → 512 MB), unit tests (`test/`, `npm test`, 23 tests on built-in `node:test`), README, `package.json` 3.0.0, `case-logo.png` removed.

## Open items
1. **Cost check** (~2026-11-15): compare Bedrock cost per image in Cost Explorer against the $0.07 Style Guide baseline. Core's price was never confirmed on the AWS pricing page.
2. **Content-filter path**: send a prompt that Stability will filter and confirm the chat shows the "Something went wrong" Giphy (covered by unit tests, not yet seen live).
3. **Optional cleanup**: `sam validate --lint` warns (W3005) about redundant `DependsOn` on the three log groups. It doesn't affect deploys; removing those three lines clears the warnings.
4. **#5 (asynchronous "Generating…" reply) on hold**: revisit only if users find the wait annoying.

---

# Phase 1: Replace the Style Guide model

## Why
`generate.js` used `stability.stable-image-style-guide-v1:0`, an image-to-image model that requires an input image, so the CASE logo was sent with every request. Nova Canvas (the model before that) reached end of life on 2026-09-30.

## Model options (Bedrock model cards, checked 2026-11-08)

| Model | Model ID | Needs input image? | us-east-1? | Price/image |
|---|---|---|---|---|
| Style Guide (old) | `stability.stable-image-style-guide-v1:0` | **Yes** | Yes (geo profile `us.`) | $0.07 (AWS pricing page) |
| **Stable Image Core 1.0 (chosen)** | `stability.stable-image-core-v1:1` | No | **No – us-west-2 in-region only** | ~$0.04 (third-party) |
| Stable Diffusion 3.5 Large | `stability.sd3-5-large-v1:0` | No (optional) | No – us-west-2 only | ~$0.08 (third-party) |
| Stable Image Ultra 1.0 | `stability.stable-image-ultra-v1:1` | No | No – us-west-2 only | $0.08–$0.14 (sources conflict) |
| Nova Canvas | `amazon.nova-canvas-v1:0` | No | EOL 2026-09-30 | n/a |

- No text-to-image model is offered in us-east-1. Style Guide is the only image generator there, and no other Bedrock provider offers image output.
- Core/SD3.5/Ultra have no cross-region inference profile, so genbot calls Bedrock in us-west-2 directly (≈70 ms extra; data stays in the US).
- Fallback: SD3.5 Large is a model-ID change (add `"mode": "text-to-image"`); Ultra is the premium option.

## Implementation notes
- `generate.js`: separate Bedrock client in `us-west-2` (S3 stays in `us-east-1`); `MODEL_ID = 'stability.stable-image-core-v1:1'`; removed logo loading and the "320px" system prompt; `aspect_ratio: '1:1'`.
- **Bedrock's Core rejects `style_preset`** (`ValidationException: Available fields for core are: prompt, negative_prompt, mode, strength, seed, output_format, image, aspect_ratio`), even though Stability's own API accepts it. The random style is appended to the prompt instead (`"<prompt>, <style> style"`); the meaningless `enhance` preset was dropped.
- Response handling checks `finish_reasons[0]` (e.g. `"Filter reason: prompt"`) and `error` *before* decoding, and throws if no image is returned.
- `template.yaml`: IAM resource `arn:aws:bedrock:us-west-2::foundation-model/stability.stable-image-core-v1:1`; `accountId` env var removed.
- Tests mock AWS with `mock.method(BedrockRuntimeClient.prototype, 'send')` / `S3Client.prototype`.

---

# Phase 2: End-to-end latency

## Request flow
1. Basecamp (Interactive Chatbot, request/reply) → API Gateway HTTP API → **genbot** Lambda (us-east-1, 512 MB)
2. genbot → **Bedrock** Stable Image Core (us-west-2)
3. genbot → **S3** PutObject → replies to Basecamp with the retrieve URL
4. **Basecamp's servers** (user agent `Ruby`) → **genbot-retrieve** Lambda Function URL → S3 GetObject → base64 response
5. Basecamp serves its own copy of the image to chat viewers

## Results (CloudWatch, one run each)
Total = genbot cold start begins → genbot-retrieve finishes serving Basecamp's fetch (includes Basecamp's ~0.5 s turnaround).

| Step | 1. Style Guide PNG (10-13) | 2. Core PNG (11-08) | 3. Core JPEG (#1 + #2) | **4. + retrieve 512 MB (#4)** |
|---|---|---|---|---|
| genbot init + duration | 0.33 + 11.2 s | 0.43 + 7.6 s | 0.39 + 5.6 s | **0.40 + 3.8 s** |
| Bedrock generation | 10.8 s | 7.2 s | 5.4 s | **3.6 s** |
| Image size | 1.1 MB PNG | 3.3 MB PNG | 0.67 MB JPEG | **0.60 MB JPEG** |
| S3 put | 0.26 s | 0.38 s | 0.18 s | **0.19 s** |
| genbot-retrieve init + duration | 0.38 + 0.68 s | 0.35 + 1.20 s | 0.34 + 0.63 s | **0.41 + 0.31 s** |
| **Total** | **13.3 s** | **10.1 s** | **7.4 s** | **5.4 s** |

How to read this:
- **Bedrock generation time varies a lot between runs** (3.6–7.2 s for Core on similar prompts). Most of the drop from run 3 to run 4 is that variance, not the memory change. Expect roughly **5–8 s** in practice.
- **JPEG (#1)** cut the image ~5× and roughly halved the S3 and retrieve times relative to PNG.
- **Retrieve memory 512 MB (#4)** halved retrieve run time (0.63 → 0.31 s) for a similar-size image; this one is a real effect, not variance.
- Cold starts (~0.4 s each for genbot and genbot-retrieve) happen on nearly every request because usage is infrequent.

## Recommendations: outcome

| # | Recommendation | Outcome |
|---|---|---|
| 1 | Generate JPEG instead of PNG | ✅ Shipped. `output_format: 'jpeg'`, key `${requestId}.jpg`, `ContentType: image/jpeg`. Also removes the risk of exceeding the 6 MB Lambda Function URL response limit (a 4.1 MB PNG ≈ 5.5 MB base64). |
| 2 | Fix content type, add caching headers in `retrieve.js` | ✅ Shipped. Content type from extension (old `.png` images still work); `cache-control: public, max-age=31536000, immutable` on images and the S3 object; `no-store` on the error 303; logs the requester's user agent. Low impact in practice, since Basecamp fetches each image only once (see below). |
| 3 | Redirect to a presigned S3 URL / CloudFront | ❌ Not doing. Basecamp fetches each image once, server-side, so this would only speed up a single ~0.7 s fetch, and presigned URLs defeat caching. Whether Basecamp's fetcher follows redirects was never tested. |
| 4 | Lambda tuning | ✅ Partial. genbot-retrieve 256 → 512 MB. Skipped: more genbot memory (it's waiting on Bedrock, using 114 of 512 MB), esbuild bundling (<0.5 s for extra build tooling), and provisioned concurrency (cost not justified). |
| 5 | Immediate "Generating…" reply, then post the image to `callback_url` | ⏸ On hold. It would feel faster but not be faster, and it adds a second chat line per command, self-invocation, and callback error handling. |

## Basecamp behavior learned
- genbot is a Basecamp **Interactive Chatbot (request/reply)**: Basecamp POSTs `{command, creator, callback_url}` and inserts the 200 response body (rich text) into the chat. `callback_url` lasts 24 hours ([chatbots.md](https://github.com/basecamp/bc-api/blob/master/sections/chatbots.md)).
- genbot replies with a **bare image URL**. Basecamp's servers (user agent `Ruby`) fetch it **once**, about 0.5 s after the reply, and viewers' browsers never call the retrieve URL. The retrieve Lambda's speed matters only for that one fetch.
- By contrast, per [rich_text.md](https://github.com/basecamp/bc-api/blob/master/sections/rich_text.md), an explicit `<img src>` in rich text is loaded by each viewer's browser on every view. That's useful to know if the reply format ever changes, since caching headers would then matter.

## Sources
- [Bedrock models at a glance](https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html)
- [Stable Image Core](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-stability-ai-stable-image-core-1-0.html) and [request/response](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-diffusion-stable-image-core-text-image-request-response.html), [Ultra](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-stability-ai-stable-image-ultra-1-0.html), [SD3.5 Large](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-stability-ai-stable-diffusion-3-5-large.html), [Style Guide](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-stability-ai-stable-image-style-guide.html), [Nova Canvas (EOL)](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-canvas.html)
- [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
- [Basecamp chatbots](https://github.com/basecamp/bc-api/blob/master/sections/chatbots.md), [Basecamp rich text](https://github.com/basecamp/bc-api/blob/master/sections/rich_text.md)
