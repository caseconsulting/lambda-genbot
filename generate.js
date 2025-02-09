import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
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

/**
 * Invokes Amazon Bedrock model to convert prompt text to image.
 *
 * @param {string} prompt - The input text prompt for the model.
 * @param {string} [modelId] - The ID of the model to use. Defaults to "amazon.nova-canvas-v1:0".
 * @returns {Uint8Array} The image bytes.
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
 * Returns URL to retrieve image from retrieve endpoint.
 *
 * @see {@link https://docs.aws.amazon.com/nova/latest/userguide/image-generation.html}
 * @see {@link https://community.aws/content/2rc9I0eNkAe22YwlNAkPuD2cHJe/harness-the-power-of-nova-canvas-for-creative-content-generation}
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
      const responseUrl = `${retrieveEndpoint}/${imageFileName}`;
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
