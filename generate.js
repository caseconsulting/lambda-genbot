import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { fromBase64 } from '@smithy/util-base64';
import { BUCKET_NAME, ERROR_IMAGE_URL, REGION } from './constants.js';

// Model and region are set from template.yaml parameters, which also scope the IAM policy.
// Defaults are for local runs and tests.
// Stable Image Core is only offered in-region in us-west-2 (no cross-region inference profile), so Bedrock is called there.
export const BEDROCK_REGION = process.env.bedrockRegion ?? 'us-west-2';
export const MODEL_ID = process.env.modelId ?? 'stability.stable-image-core-v1:1';

// Bound each Bedrock attempt and the number of attempts, so a slow or throttled generation still leaves time
// to reply with the 'Something went wrong' message before the 30s Lambda/HTTP API timeout
const bedrockClient = new BedrockRuntimeClient({
  region: BEDROCK_REGION,
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 3000, requestTimeout: 20000 }
});
const s3Client = new S3Client({ region: REGION });

// Time reserved after generation for saving the image and responding
export const SAVE_BUDGET_MS = 5000;

// Bedrock's Stable Image Core rejects the style_preset field, so a random style is appended to the prompt text instead
export const STYLES = [
  '3d model',
  'analog film',
  'anime',
  'cinematic',
  'comic book',
  'digital art',
  'fantasy art',
  'isometric',
  'line art',
  'low poly',
  'modeling compound',
  'neon punk',
  'origami',
  'photographic',
  'pixel art',
  'tile texture'
];

// Stable Image Core accepts prompts up to 10,000 characters; leave room for the longest ', <style> style' suffix
const MODEL_MAX_PROMPT_LENGTH = 10000;
export const MAX_PROMPT_LENGTH =
  MODEL_MAX_PROMPT_LENGTH - Math.max(...STYLES.map((style) => `, ${style} style`.length));

/**
 * Builds the Stable Image Core text-to-image request payload, adding a random style to the prompt.
 * Prompts longer than MAX_PROMPT_LENGTH are truncated so the styled prompt stays within the model's limit.
 *
 * @param {string} prompt - The input text prompt for the model.
 * @param {function(): number} [random=Math.random] - Random number generator returning [0, 1).
 * @returns {Object} The request payload.
 */
export const buildPayload = (prompt, random = Math.random) => {
  const style = STYLES[Math.floor(random() * STYLES.length)];
  return {
    prompt: `${prompt.slice(0, MAX_PROMPT_LENGTH)}, ${style} style`,
    aspect_ratio: '1:1',
    // JPEG is ~6x smaller than PNG (~0.5 MB vs ~3.3 MB at 1536x1536), which speeds up storage, retrieval, and display
    output_format: 'jpeg'
  };
};

/**
 * Invokes Amazon Bedrock model to convert prompt text to image.
 * Uses Stability AI Stable Image Core text-to-image model with a random style added to the prompt.
 *
 * NOTE: Previously used Amazon Nova Canvas (end of life 2026-09-30), then Stable Image Style Guide,
 * which required a starter image (CASE logo).
 *
 * @see {@link https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-stability-ai-stable-image-core-1-0.html}
 * @see {@link https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-diffusion-stable-image-core-text-image-request-response.html}
 *
 * @param {string} prompt - The input text prompt for the model.
 * @param {number} timeoutMs - Maximum time to wait for Bedrock, including retries.
 * @returns {Uint8Array} The image bytes.
 */
export const invokeModel = async (prompt, timeoutMs) => {
  // Prepare the payload
  const payload = buildPayload(prompt);
  console.log(`Prepared payload for text prompt: ${payload.prompt}`);

  // Invoke the model with the payload and wait for the response
  console.log(`Generating image with Bedrock model ${MODEL_ID} in ${BEDROCK_REGION} (timeout ${timeoutMs} ms)`);
  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    accept: 'application/json',
    contentType: 'application/json',
    body: JSON.stringify(payload)
  });
  const response = await bedrockClient.send(command, { abortSignal: AbortSignal.timeout(timeoutMs) });

  // Decode response, check for filtered or failed generation, and return image
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const finishReason = responseBody.finish_reasons?.[0] ?? responseBody.error;
  const base64Image = responseBody.images?.[0];
  if (finishReason || !base64Image) {
    throw new Error(`Model invocation error. Reason: ${finishReason ?? 'no image returned'}`);
  }
  const imageBuffer = fromBase64(base64Image);

  console.log(`Successfully generated image. Image size: ${imageBuffer.length} bytes`);
  return imageBuffer;
};

/**
 * Saves image to bucket.
 *
 * @param {Uint8Array} imageBuffer - The image bytes.
 * @param {string} requestId - The identifier of the Lambda invocation request.
 * @returns {string} The image file name saved to bucket.
 */
export const saveImageToBucket = async (imageBuffer, requestId) => {
  try {
    // Create image file name
    const imageFileName = `${requestId}.jpg`;

    // Write image file to bucket; genbot-retrieve serves it with the stored content type
    console.log(`Saving ${imageFileName} image to ${BUCKET_NAME} bucket`);
    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: imageFileName,
      Body: imageBuffer,
      ContentType: 'image/jpeg'
    });
    await s3Client.send(putCommand);
    console.log(`Saved ${imageFileName} image to ${BUCKET_NAME} bucket`);

    // Return image file name
    return imageFileName;
  } catch (error) {
    if (error instanceof S3ServiceException) {
      console.error(`Error from S3 while uploading object to ${BUCKET_NAME}.  ${error.name}: ${error.message}`);
    }
    throw error;
  }
};

/**
 * Uses generative AI to create image based on given prompt.
 * Saves image to S3 bucket.
 * Returns URL to retrieve image.
 *
 * @param {Object} event - API Gateway HTTP API Lambda proxy integration payload
 * @see {@link https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html}
 *
 * @param {Object} context - Lambda context object
 * @see {@link https://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html}
 *
 * @returns {Object} object - API Gateway HTTP API Lambda proxy integration response
 * @see {@link https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html}
 */
export const handler = async (event, context) => {
  const requestId = context.awsRequestId;

  // Public endpoint: reject anything that isn't a JSON body
  let body;
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    console.log('Bad request, body is not valid JSON');
    return { statusCode: 400, body: 'Bad Request' };
  }
  const command = body?.command;
  const companyId = body?.creator?.company?.id;

  // Only allow requests from the configured Basecamp company; deny if it's not configured
  const expectedCompanyId = process.env.companyId;
  if (!expectedCompanyId || companyId == null || String(companyId) !== expectedCompanyId) {
    console.log(`Access denied, invalid company ID provided: ${companyId}`);
    return { statusCode: 403, body: 'Access Denied' };
  }

  // Don't pay to generate an image from an empty prompt
  const prompt = typeof command === 'string' ? command.trim() : '';
  if (!prompt) {
    console.log('No prompt provided');
    return { statusCode: 200, body: 'Please include a description of the image to generate.' };
  }

  try {
    const imageBuffer = await invokeModel(prompt, context.getRemainingTimeInMillis() - SAVE_BUDGET_MS);
    const imageFileName = await saveImageToBucket(imageBuffer, requestId);
    const responseUrl = `${process.env.retrieveApi}${imageFileName}`;
    console.log(`Returning response URL: ${responseUrl}`);
    return { statusCode: 200, body: responseUrl };
  } catch (error) {
    // Log the whole error (name, message, stack, and AWS $metadata request ID) to tell failure types apart
    console.error('Error generating image:', error);
    return { statusCode: 200, body: `Something went wrong :( ${ERROR_IMAGE_URL}` };
  }
};
