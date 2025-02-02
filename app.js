import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fromBase64 } from '@smithy/util-base64';

// Create Amazon Bedrock Runtime and S3 clients
const REGION = 'us-east-1';
const config = { region: REGION };
const bedrockClient = new BedrockRuntimeClient(config);
const s3Client = new S3Client(config);

const IMAGE_GENERATION_HEIGHT_WIDTH_IN_PX = 320;
const IMAGE_GENERATION_MAX_SEED = 1048576;
const IMAGE_GENERATION_PROMPT_ADHERENCE = 8.0;

const BUCKET_NAME = 'case-consulting-mgmt-genbot-images';
const PRESIGNED_URL_EXPIRES_IN_DAYS = 7;

/**
 * Invokes Amazon Bedrock model to convert prompt text to image.
 *
 * @param {string} prompt - The input text prompt for the model.
 * @param {string} [modelId] - The ID of the model to use. Defaults to "amazon.nova-canvas-v1:0".
 * @returns {Uint8Array} Image bytes
 */
export const invokeModel = async (prompt, modelId = 'amazon.nova-canvas-v1:0') => {
  try {
    // Prepare the payload
    console.log(`Preparing payload for text prompt: ${prompt}`);
    const seed = Math.floor(Math.random() * IMAGE_GENERATION_MAX_SEED);
    const payload = {
      taskType: 'TEXT_IMAGE',
      textToImageParams: {
        text: prompt
      },
      imageGenerationConfig: {
        numberOfImages: 1, // Default is 1
        height: IMAGE_GENERATION_HEIGHT_WIDTH_IN_PX, // Default is 1024. Minimum is 320. Maximum is 4096.
        width: IMAGE_GENERATION_HEIGHT_WIDTH_IN_PX, // Default is 1024. Minimum is 320. Maximum is 4096.
        quality: 'standard', // Default is 'standard'
        cfgScale: IMAGE_GENERATION_PROMPT_ADHERENCE, // Default is 6.5. Lower value introduces more randomness.
        seed // Default is 12
      }
    };

    // Invoke the model with the payload and wait for the response
    console.log(`Generating image with Amazon Nova Canvas model ${modelId}`);
    const params = {
      modelId: modelId,
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
      throw new Error(`Image generation error. Error is: ${finishReason}`);
    }

    console.log(`Successfully generated image with Amazon Nova Canvas model ${modelId}`);
    console.log(`Image generated successfully. Image size: ${imageBuffer.length} bytes`);
    return imageBuffer;
  } catch (error) {
    throw error;
  }
};

/**
 * Saves image to bucket and returns presigned URL to get image file from bucket.
 *
 * @param {Uint8Array} imageBuffer - The image bytes.
 * @param {string} requestId - The identifier of the Lambda invocation request.
 * @returns {string} Presigned URL to get image file from bucket
 */
export const saveImageToBucket = async (imageBuffer, requestId) => {
  try {
    // Write image file to bucket
    const imageFileName = `${requestId}.png`;
    console.log(`Saving ${imageFileName} image to ${BUCKET_NAME} bucket`);
    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: imageFileName,
      Body: imageBuffer,
      ContentType: 'image/png'
    });
    const response = await s3Client.send(putCommand);
    console.log(`Saved ${imageFileName} image to ${BUCKET_NAME} bucket`);

    // Return presigned URL to get image file from bucket
    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: imageFileName
    });
    const expiresInSeconds = PRESIGNED_URL_EXPIRES_IN_DAYS * 24 * 60 * 60; // # days * 24 hours/day * 60 mins/hour * 60 secs/hour
    console.log(`Generating presigned URL that expires in ${expiresInSeconds} seconds`);
    const url = await getSignedUrl(s3Client, getCommand, { expiresIn: expiresInSeconds });
    return url;
  } catch (error) {
    if (error instanceof S3ServiceException) {
      console.error(`Error from S3 while uploading object to ${BUCKET_NAME}.  ${error.name}: ${error.message}`);
    }
    throw error;
  }
};

/**
 * Uses generative AI to create image based on given search prompt.
 * Invokes Amazon Bedrock to use Amazon Nova Canvas image generation model.
 * @see {@link https://docs.aws.amazon.com/nova/latest/userguide/image-generation.html}
 *
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input
 *
 * Context doc: https://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html
 * @param {Object} context - Lambda context object
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output
 *
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
      const url = await saveImageToBucket(imageBuffer, requestId);
      const html = `<img src="${url}" alt="${command}" width="${IMAGE_GENERATION_HEIGHT_WIDTH_IN_PX}" height="${IMAGE_GENERATION_HEIGHT_WIDTH_IN_PX}"/>`;
      response = {
        statusCode: 200,
        body: html
      };
    } catch (error) {
      console.error('Error generating image:', error);
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
