import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { fromBase64 } from '@smithy/util-base64';

// Lambda and S3 bucket live in us-east-1.
// Stable Image Core is only offered in-region in us-west-2 (no cross-region inference profile), so Bedrock is called there.
const REGION = 'us-east-1';
const BEDROCK_REGION = 'us-west-2';
const bedrockClient = new BedrockRuntimeClient({ region: BEDROCK_REGION });
const s3Client = new S3Client({ region: REGION });

export const MODEL_ID = 'stability.stable-image-core-v1:1';

const BUCKET_NAME = 'case-consulting-mgmt-genbot-images';

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

/**
 * Builds the Stable Image Core text-to-image request payload, adding a random style to the prompt.
 *
 * @param {string} prompt - The input text prompt for the model.
 * @param {function(): number} [random=Math.random] - Random number generator returning [0, 1).
 * @returns {Object} The request payload.
 */
export const buildPayload = (prompt, random = Math.random) => {
  const style = STYLES[Math.floor(random() * STYLES.length)];
  return {
    prompt: `${prompt}, ${style} style`,
    aspect_ratio: '1:1',
    output_format: 'png'
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
 * @returns {Uint8Array} The image bytes.
 */
export const invokeModel = async (prompt) => {
  // Prepare the payload
  const payload = buildPayload(prompt);
  console.log(`Prepared payload for text prompt: ${payload.prompt}`);

  // Invoke the model with the payload and wait for the response
  console.log(`Generating image with Bedrock model ${MODEL_ID} in ${BEDROCK_REGION}`);
  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    accept: 'application/json',
    contentType: 'application/json',
    body: JSON.stringify(payload)
  });
  const response = await bedrockClient.send(command);

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
    const imageFileName = `${requestId}.png`;

    // Write image file to bucket
    console.log(`Saving ${imageFileName} image to ${BUCKET_NAME} bucket`);
    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: imageFileName,
      Body: imageBuffer,
      ContentType: 'image/png'
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
  let response;

  const requestId = context.awsRequestId;
  const body = JSON.parse(event.body);
  const command = body.command;
  const companyId = body.creator.company.id;

  if (companyId == process.env.companyId) {
    try {
      const imageBuffer = await invokeModel(command);
      const imageFileName = await saveImageToBucket(imageBuffer, requestId);
      const retrieveEndpoint = process.env.retrieveApi;
      const responseUrl = `${retrieveEndpoint}${imageFileName}`;
      console.log(`Returning response URL: ${responseUrl}`);
      response = {
        statusCode: 200,
        body: responseUrl
      };
    } catch (error) {
      console.error('Error generating image:', error.message);
      response = {
        statusCode: 200,
        body: 'Something went wrong :( https://media.giphy.com/media/l41JNsXAvFvoHvWJW/giphy.gif'
      };
    }
  } else {
    console.log(`Access denied, invalid company ID provided: ${companyId}`);
    response = {
      statusCode: 403,
      body: 'Access Denied'
    };
  }

  return response;
};
