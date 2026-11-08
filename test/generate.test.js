import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import {
  MODEL_ID,
  STYLES,
  buildPayload,
  handler,
  invokeModel,
  saveImageToBucket
} from '../generate.js';

const IMAGE_BYTES = Buffer.from('fake-png-bytes');
const COMPANY_ID = '12345';
const RETRIEVE_API = 'https://retrieve.example.com/';

/** Builds a Bedrock InvokeModel response whose body is the given JSON object. */
const bedrockResponse = (json) => ({ body: new TextEncoder().encode(JSON.stringify(json)) });

const successBody = { seeds: [42], finish_reasons: [null], images: [IMAGE_BYTES.toString('base64')] };

/** Builds an API Gateway HTTP API event like the one sent by Basecamp. */
const apiEvent = (command, companyId = COMPANY_ID) => ({
  body: JSON.stringify({ command, creator: { company: { id: companyId } } })
});

let bedrockSend;
let s3Send;

beforeEach(() => {
  // Silence function logging during tests
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
  bedrockSend = mock.method(BedrockRuntimeClient.prototype, 'send', async () => bedrockResponse(successBody));
  s3Send = mock.method(S3Client.prototype, 'send', async () => ({}));
  process.env.companyId = COMPANY_ID;
  process.env.retrieveApi = RETRIEVE_API;
});

afterEach(() => {
  mock.restoreAll();
  delete process.env.companyId;
  delete process.env.retrieveApi;
});

describe('buildPayload', () => {
  it('builds a text-only Stable Image Core payload with no starter image or style_preset', () => {
    const payload = buildPayload('monster pizza party', () => 0);
    assert.deepEqual(payload, {
      prompt: `monster pizza party, ${STYLES[0]} style`,
      aspect_ratio: '1:1',
      output_format: 'jpeg'
    });
  });

  it('selects the last style for random values just below 1', () => {
    assert.equal(buildPayload('x', () => 0.9999).prompt, `x, ${STYLES.at(-1)} style`);
  });

  it('always appends a valid style', () => {
    for (let i = 0; i < 100; i++) {
      const style = buildPayload('x').prompt.replace(/^x, (.*) style$/, '$1');
      assert.ok(STYLES.includes(style), style);
    }
  });
});

describe('invokeModel', () => {
  it('invokes Stable Image Core in us-west-2 and returns decoded image bytes', async () => {
    const image = await invokeModel('monster pizza party');

    assert.deepEqual(Buffer.from(image), IMAGE_BYTES);
    assert.equal(bedrockSend.mock.callCount(), 1);

    const call = bedrockSend.mock.calls[0];
    assert.equal(await call.this.config.region(), 'us-west-2');
    const command = call.arguments[0];
    assert.ok(command instanceof InvokeModelCommand);
    assert.equal(command.input.modelId, MODEL_ID);
    assert.equal(command.input.contentType, 'application/json');
    const payload = JSON.parse(command.input.body);
    assert.match(payload.prompt, /^monster pizza party, .+ style$/);
    assert.equal(payload.output_format, 'jpeg');
    // Only fields accepted by Bedrock's Stable Image Core
    assert.deepEqual(Object.keys(payload).sort(), ['aspect_ratio', 'output_format', 'prompt']);
  });

  it('throws when the model filters the request', async () => {
    bedrockSend.mock.mockImplementation(async () =>
      bedrockResponse({ seeds: [1], finish_reasons: ['Filter reason: prompt'], images: [] })
    );
    await assert.rejects(invokeModel('bad prompt'), /Filter reason: prompt/);
  });

  it('throws when the response contains an error', async () => {
    bedrockSend.mock.mockImplementation(async () => bedrockResponse({ error: 'Inference error' }));
    await assert.rejects(invokeModel('x'), /Inference error/);
  });

  it('throws when no image is returned', async () => {
    bedrockSend.mock.mockImplementation(async () => bedrockResponse({ finish_reasons: [null], images: [] }));
    await assert.rejects(invokeModel('x'), /no image returned/);
  });

  it('propagates Bedrock client errors', async () => {
    bedrockSend.mock.mockImplementation(async () => {
      throw new Error('AccessDeniedException');
    });
    await assert.rejects(invokeModel('x'), /AccessDeniedException/);
  });
});

describe('saveImageToBucket', () => {
  it('puts the cacheable JPEG in the images bucket keyed by request ID', async () => {
    const fileName = await saveImageToBucket(IMAGE_BYTES, 'req-1');

    assert.equal(fileName, 'req-1.jpg');
    assert.equal(s3Send.mock.callCount(), 1);
    const call = s3Send.mock.calls[0];
    assert.equal(await call.this.config.region(), 'us-east-1');
    const command = call.arguments[0];
    assert.ok(command instanceof PutObjectCommand);
    assert.deepEqual(command.input, {
      Bucket: 'case-consulting-mgmt-genbot-images',
      Key: 'req-1.jpg',
      Body: IMAGE_BYTES,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable'
    });
  });

  it('logs and rethrows S3 service errors', async () => {
    const s3Error = new S3ServiceException({ name: 'NoSuchBucket', $fault: 'client', $metadata: {}, message: 'nope' });
    s3Send.mock.mockImplementation(async () => {
      throw s3Error;
    });

    await assert.rejects(saveImageToBucket(IMAGE_BYTES, 'req-1'), s3Error);
    assert.match(console.error.mock.calls[0].arguments[0], /NoSuchBucket: nope/);
  });
});

describe('handler', () => {
  it('generates, saves, and returns the retrieve URL for the allowed company', async () => {
    const response = await handler(apiEvent('monster pizza party'), { awsRequestId: 'req-1' });

    assert.deepEqual(response, { statusCode: 200, body: `${RETRIEVE_API}req-1.jpg` });
    assert.equal(bedrockSend.mock.callCount(), 1);
    assert.equal(s3Send.mock.callCount(), 1);
  });

  it('returns a friendly message when image generation fails', async () => {
    bedrockSend.mock.mockImplementation(async () =>
      bedrockResponse({ finish_reasons: ['Filter reason: prompt'], images: [] })
    );

    const response = await handler(apiEvent('bad prompt'), { awsRequestId: 'req-1' });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /^Something went wrong/);
    assert.equal(s3Send.mock.callCount(), 0);
  });

  it('returns a friendly message when saving fails', async () => {
    s3Send.mock.mockImplementation(async () => {
      throw new Error('S3 down');
    });

    const response = await handler(apiEvent('x'), { awsRequestId: 'req-1' });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /^Something went wrong/);
  });

  it('denies access for other companies without calling AWS', async () => {
    const response = await handler(apiEvent('x', '99999'), { awsRequestId: 'req-1' });

    assert.deepEqual(response, { statusCode: 403, body: 'Access Denied' });
    assert.equal(bedrockSend.mock.callCount(), 0);
    assert.equal(s3Send.mock.callCount(), 0);
  });
});
