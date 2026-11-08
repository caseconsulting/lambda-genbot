import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { getContentType, getImage, handler } from '../retrieve.js';

const IMAGE_BYTES = Buffer.from('fake-jpeg-bytes');
const ERROR_IMAGE_URL = 'https://media.giphy.com/media/l41JNsXAvFvoHvWJW/giphy.gif';

/** Builds a Lambda Function URL event for the given request path. */
const urlEvent = (path) => ({ requestContext: { http: { path, userAgent: 'test-agent' } } });

/** Builds an S3 GetObject response with the given bytes. */
const s3Object = (bytes) => ({ Body: { transformToByteArray: async () => new Uint8Array(bytes) } });

let s3Send;

beforeEach(() => {
  // Silence function logging during tests
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
  s3Send = mock.method(S3Client.prototype, 'send', async () => s3Object(IMAGE_BYTES));
});

afterEach(() => {
  mock.restoreAll();
});

describe('getContentType', () => {
  it('maps JPEG extensions to image/jpeg', () => {
    assert.equal(getContentType('abc.jpg'), 'image/jpeg');
    assert.equal(getContentType('abc.JPEG'), 'image/jpeg');
  });

  it('maps older PNG images to image/png', () => {
    assert.equal(getContentType('abc.png'), 'image/png');
  });

  it('defaults to image/jpeg for unknown or missing extensions', () => {
    assert.equal(getContentType('abc.gif'), 'image/jpeg');
    assert.equal(getContentType('abc'), 'image/jpeg');
  });
});

describe('getImage', () => {
  it('gets the object from the images bucket and returns it Base64-encoded', async () => {
    const body = await getImage('req-1.jpg');

    assert.equal(body, IMAGE_BYTES.toString('base64'));
    const command = s3Send.mock.calls[0].arguments[0];
    assert.ok(command instanceof GetObjectCommand);
    assert.deepEqual(command.input, { Bucket: 'case-consulting-mgmt-genbot-images', Key: 'req-1.jpg' });
  });

  it('logs and rethrows missing images', async () => {
    const error = new NoSuchKey({ $metadata: {}, message: 'missing' });
    s3Send.mock.mockImplementation(async () => {
      throw error;
    });

    await assert.rejects(getImage('nope.jpg'), error);
    assert.equal(console.error.mock.calls[0].arguments[0], 'Image file not found.');
  });
});

describe('handler', () => {
  it('returns a JPEG image with immutable caching', async () => {
    const response = await handler(urlEvent('/req-1.jpg'), {});

    assert.deepEqual(response, {
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'public, max-age=31536000, immutable'
      },
      statusCode: 200,
      body: IMAGE_BYTES.toString('base64'),
      isBase64Encoded: true
    });
    assert.equal(s3Send.mock.calls[0].arguments[0].input.Key, 'req-1.jpg');
  });

  it('returns older PNG images with the PNG content type', async () => {
    const response = await handler(urlEvent('/old.png'), {});

    assert.equal(response.headers['content-type'], 'image/png');
  });

  it('logs the requesting user agent', async () => {
    await handler(urlEvent('/req-1.jpg'), {});

    assert.match(console.log.mock.calls[0].arguments[0], /user agent: test-agent/);
  });

  it('redirects to the error image without caching when retrieval fails', async () => {
    s3Send.mock.mockImplementation(async () => {
      throw new NoSuchKey({ $metadata: {}, message: 'missing' });
    });

    const response = await handler(urlEvent('/nope.jpg'), {});

    assert.deepEqual(response, {
      statusCode: 303,
      headers: { Location: ERROR_IMAGE_URL, 'cache-control': 'no-store' }
    });
  });
});
