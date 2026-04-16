import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { fromBase64 } from '@smithy/util-base64';
import { readFile } from 'node:fs/promises';

// Create Amazon Bedrock Runtime and S3 clients
const REGION = 'us-east-1';
const config = { region: REGION };
const bedrockClient = new BedrockRuntimeClient(config);
const s3Client = new S3Client(config);

const BUCKET_NAME = 'case-consulting-mgmt-genbot-images';

const STYLE_PRESETS = [
  '3d-model',
  'analog-film',
  'anime',
  'cinematic',
  'comic-book',
  'digital-art',
  'enhance',
  'fantasy-art',
  'isometric',
  'line-art',
  'low-poly',
  'modeling-compound',
  'neon-punk',
  'origami',
  'photographic',
  'pixel-art',
  'tile-texture'
];

/**
 * Converts image to Base64-encoded bytes.
 *
 * @param {string} path - The image path.
 * @returns {string} The Base-64 encoded image bytes.
 */
export const imageToBase64 = async (path) => {
  try {
    const buffer = await readFile(path);
    return buffer.toString('base64');
  } catch (error) {
    console.error('Error reading image:', error);
    throw error;
  }
};

/**
 * Invokes Amazon Bedrock model to convert prompt text to image.
 * Uses Stability AI Stable Image Style Guide model to generate new image based on prompt text, source image (CASE logo),
 * and random style preset.
 *
 * NOTE: Previously used Amazon Nova Canvas model, but it was retired as legacy and could no longer be called.
 *
 * @see {@link https://docs.aws.amazon.com/bedrock/latest/userguide/stable-image-services.html}
 * @see {@link https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-stability-ai-stable-image-style-guide.html}
 *
 * @param {string} prompt - The input text prompt for the model.
 * @returns {Uint8Array} The image bytes.
 */
export const invokeModel = async (prompt) => {
  try {
    // Prepare the payload
    console.log(`Preparing payload for text prompt: ${prompt}`);
    const randomNumber = Math.floor(Math.random() * STYLE_PRESETS.length);
    const image = await imageToBase64('./case-logo.png');
    const payload = {
      image,
      prompt,
      output_format: 'png',
      style_preset: STYLE_PRESETS[randomNumber]
    };

    // Invoke the model with the payload and wait for the response
    const modelId = `arn:aws:bedrock:${REGION}:${process.env.accountId}:inference-profile/us.stability.stable-image-style-guide-v1:0`;
    console.log(`Generating image with Bedrock model ${modelId}`);
    const params = {
      modelId,
      accept: 'application/json',
      contentType: 'application/json',
      body: JSON.stringify(payload)
    };
    const command = new InvokeModelCommand(params);
    const response = await bedrockClient.send(command);

    // Decode response and return image
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const base64Image = responseBody.images[0];
    const imageBuffer = fromBase64(base64Image);

    const finishReason = responseBody.error;
    if (finishReason) {
      throw new Error(`Model invocation error. Error is: ${finishReason}`);
    }

    console.log(`Successfully generated image. Image size: ${imageBuffer.length} bytes`);
    return imageBuffer;
  } catch (error) {
    throw error;
  }
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
    const response = await s3Client.send(putCommand);
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
