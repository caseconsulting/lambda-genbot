import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { toBase64 } from '@smithy/util-base64';

// Create S3 client
const REGION = 'us-east-1';
const config = { region: REGION };
const client = new S3Client(config);

const BUCKET_NAME = 'case-consulting-mgmt-genbot-images';

/**
 * Gets image from bucket.
 *
 * @param {string} imageFileName - The image file name.
 * @returns {string} The image file converted to Base64-encoded string.
 */
export const getImage = async (imageFileName) => {
  try {
    // Get image file object from bucket
    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: imageFileName
    });
    const response = await client.send(getCommand);

    // Return image as Base64-encoded string
    const imageBytes = await response.Body.transformToByteArray();
    return toBase64(imageBytes);
  } catch (error) {
    if (error instanceof NoSuchKey) {
      console.error('Image file not found.');
    } else {
      console.error(`Error while getting image from ${BUCKET_NAME}.  ${error.name}: ${error.message}`);
    }
    throw error;
  }
};

/**
 * Gets specified image from bucket.
 * Returns Base64-encoded image string.
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

  const imagePath = event.pathParameters.imagePath;

  try {
    console.log(`Getting ${imagePath} from ${BUCKET_NAME}`);
    const base64Body = await getImage(imagePath);
    response = {
      headers: {
        'content-type': 'image/jpg'
      },
      statusCode: 200,
      body: base64Body,
      isBase64Encoded: true
    };
  } catch (error) {
    response = {
      statusCode: 303,
      headers: {
        Location: 'https://media.giphy.com/media/l41JNsXAvFvoHvWJW/giphy.gif'
      }
    };
  }

  return response;
};
