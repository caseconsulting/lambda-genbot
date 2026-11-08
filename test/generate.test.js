import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import {
  MAX_PROMPT_LENGTH,
  MODEL_ID,
  SAVE_BUDGET_MS,
  STYLES,
  buildPayload,
  handler,
  invokeModel,
  saveImageToBucket
} from '../generate.js';

const IMAGE_BYTES = Buffer.from('fake-png-bytes');
const COMPANY_ID = '12345';
const RETRIEVE_API = 'https://retrieve.example.com/';
const ERROR_IMAGE_URL = 'https://media.giphy.com/media/l41JNsXAvFvoHvWJW/giphy.gif';

/** Builds a Lambda context with 30s remaining. */
const lambdaContext = { awsRequestId: 'req-1', getRemainingTimeInMillis: () => 30000 };

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

  it('truncates long prompts so the styled prompt stays within the 10,000 character model limit', () => {
    for (let i = 0; i < STYLES.length; i++) {
      const payload = buildPayload('a'.repeat(20000), () => i / STYLES.length);
      assert.ok(payload.prompt.length <= 10000, `${STYLES[i]}: ${payload.prompt.length}`);
      assert.ok(payload.prompt.startsWith('a'.repeat(MAX_PROMPT_LENGTH) + ', '));
    }
  });
});

describe('invokeModel', () => {
  it('invokes Stable Image Core in us-west-2 and returns decoded image bytes', async () => {
    const image = await invokeModel('monster pizza party', 25000);

    assert.deepEqual(Buffer.from(image), IMAGE_BYTES);
    assert.equal(bedrockSend.mock.callCount(), 1);

    const call = bedrockSend.mock.calls[0];
    assert.equal(await call.this.config.region(), 'us-west-2');
    assert.equal(await call.this.config.maxAttempts(), 2);
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

  it('aborts the Bedrock call after the given timeout', async () => {
    bedrockSend.mock.mockImplementation(
      (command, { abortSignal }) =>
        new Promise((resolve, reject) => abortSignal.addEventListener('abort', () => reject(abortSignal.reason)))
    );
    await assert.rejects(invokeModel('x', 10), { name: 'TimeoutError' });
  });

  it('throws when the model filters the request', async () => {
    bedrockSend.mock.mockImplementation(async () =>
      bedrockResponse({ seeds: [1], finish_reasons: ['Filter reason: prompt'], images: [] })
    );
    await assert.rejects(invokeModel('bad prompt', 25000), /Filter reason: prompt/);
  });

  it('throws when the response contains an error', async () => {
    bedrockSend.mock.mockImplementation(async () => bedrockResponse({ error: 'Inference error' }));
    await assert.rejects(invokeModel('x', 25000), /Inference error/);
  });

  it('throws when no image is returned', async () => {
    bedrockSend.mock.mockImplementation(async () => bedrockResponse({ finish_reasons: [null], images: [] }));
    await assert.rejects(invokeModel('x', 25000), /no image returned/);
  });

  it('propagates Bedrock client errors', async () => {
    bedrockSend.mock.mockImplementation(async () => {
      throw new Error('AccessDeniedException');
    });
    await assert.rejects(invokeModel('x', 25000), /AccessDeniedException/);
  });
});

describe('saveImageToBucket', () => {
  it('puts the JPEG in the images bucket keyed by request ID', async () => {
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
      ContentType: 'image/jpeg'
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
    const response = await handler(apiEvent('monster pizza party'), lambdaContext);

    assert.deepEqual(response, { statusCode: 200, body: `${RETRIEVE_API}req-1.jpg` });
    assert.equal(bedrockSend.mock.callCount(), 1);
    assert.equal(s3Send.mock.callCount(), 1);
  });

  it('gives Bedrock the remaining time minus the time reserved for saving', async () => {
    const timeout = mock.method(AbortSignal, 'timeout');

    await handler(apiEvent('x'), lambdaContext);

    assert.deepEqual(timeout.mock.calls[0].arguments, [30000 - SAVE_BUDGET_MS]);
  });

  it('trims the prompt before generating', async () => {
    await handler(apiEvent('  monster pizza party  '), lambdaContext);

    const payload = JSON.parse(bedrockSend.mock.calls[0].arguments[0].input.body);
    assert.match(payload.prompt, /^monster pizza party, .+ style$/);
  });

  it('asks for a prompt without calling AWS when the command is missing or blank', async () => {
    for (const command of [undefined, '', '   ', 42]) {
      const response = await handler(apiEvent(command), lambdaContext);

      assert.deepEqual(response, { statusCode: 200, body: 'Please include a description of the image to generate.' });
    }
    assert.equal(bedrockSend.mock.callCount(), 0);
    assert.equal(s3Send.mock.callCount(), 0);
  });

  it('returns a friendly message when image generation fails', async () => {
    bedrockSend.mock.mockImplementation(async () =>
      bedrockResponse({ finish_reasons: ['Filter reason: prompt'], images: [] })
    );

    const response = await handler(apiEvent('bad prompt'), lambdaContext);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, `Something went wrong :( ${ERROR_IMAGE_URL}`);
    assert.equal(s3Send.mock.callCount(), 0);
  });

  it('logs the whole error so its type and request ID are kept', async () => {
    const error = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
      $metadata: { requestId: 'aws-req-1' }
    });
    bedrockSend.mock.mockImplementation(async () => {
      throw error;
    });

    await handler(apiEvent('x'), lambdaContext);

    assert.deepEqual(console.error.mock.calls[0].arguments, ['Error generating image:', error]);
  });

  it('returns a friendly message when saving fails', async () => {
    s3Send.mock.mockImplementation(async () => {
      throw new Error('S3 down');
    });

    const response = await handler(apiEvent('x'), lambdaContext);

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /^Something went wrong/);
  });

  it('denies access for other companies without calling AWS', async () => {
    const response = await handler(apiEvent('x', '99999'), lambdaContext);

    assert.deepEqual(response, { statusCode: 403, body: 'Access Denied' });
    assert.equal(bedrockSend.mock.callCount(), 0);
    assert.equal(s3Send.mock.callCount(), 0);
  });

  it('accepts a numeric company ID matching the configured ID', async () => {
    const response = await handler(apiEvent('x', Number(COMPANY_ID)), lambdaContext);

    assert.equal(response.statusCode, 200);
  });

  it('denies a null company ID when the configured ID is missing', async () => {
    delete process.env.companyId;

    const response = await handler(apiEvent('x', null), lambdaContext);

    assert.deepEqual(response, { statusCode: 403, body: 'Access Denied' });
    assert.equal(bedrockSend.mock.callCount(), 0);
  });

  it('denies requests without a creator', async () => {
    const response = await handler({ body: JSON.stringify({ command: 'x' }) }, lambdaContext);

    assert.deepEqual(response, { statusCode: 403, body: 'Access Denied' });
  });

  it('rejects a missing or invalid JSON body without calling AWS', async () => {
    for (const event of [{}, { body: '' }, { body: 'not json' }]) {
      const response = await handler(event, lambdaContext);

      assert.deepEqual(response, { statusCode: 400, body: 'Bad Request' });
    }
    assert.equal(bedrockSend.mock.callCount(), 0);
  });
});
