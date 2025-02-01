import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromBase64 } from '@aws-sdk/util-base64';

// Create Amazon Bedrock Runtime client
const REGION = 'us-east-1';
const config = { region: REGION };
const client = new BedrockRuntimeClient(config);

/**
 * Invokes Amazon Bedrock model.
 *
 * @param {string} prompt - The input text prompt for the model.
 * @param {string} [modelId] - The ID of the model to use. Defaults to "amazon.nova-canvas-v1:0".
 * @returns {string} Base64-encoded image
 */
export const invokeModel = async (prompt, modelId = 'amazon.nova-canvas-v1:0') => {
  try {
    // Prepare the payload
    console.log(`Preparing payload for text prompt: ${prompt}`);
    const payload = {
      taskType: 'TEXT_IMAGE',
      textToImageParams: {
        text: prompt
      },
      imageGenerationConfig: {
        numberOfImages: 1, // default is 1
        height: 512, // default is 1024
        width: 512, // default is 1024
        quality: 'standard', // default is 'standard'
        cfgScale: 8.0, // default is 6.5
        seed: 42 // default is 12
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
    const response = await client.send(command);

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
    return base64Image;
  } catch (error) {
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

  const body = JSON.parse(event.body);
  const prompt = body.prompt;
  const companyId = body.creator.company.id;

  if (companyId == process.env.companyId) {
    try {
      const base64Image = await invokeModel(prompt);
      response = {
        statusCode: 200,
        body: base64Image
      };
    } catch (error) {
      console.error('Error generating image:', error);
      response = {
        statusCode: 200,
        body: 'Something went wrong :( https://media.giphy.com/media/l41JNsXAvFvoHvWJW/giphy.gif'
      };
    }
  } else {
    response = {
      statusCode: 403,
      body: 'Access Denied'
    };
    console.log('Access denied');
  }

  return response;
};
