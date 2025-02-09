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
 * Returns image as Base64-encoded string.
 *
 * @param {Object} event - Lambda Function URL request
 * @see {@link https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html}
 *
 * @param {Object} context - Lambda context object
 * @see {@link https://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html}
 *
 * @returns {Object} object - Lambda Function URL response
 * @see {@link https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html}
 */
export const handler = async (event, context) => {
  let response;

  try {
    // Obtain image file name from request path (e.g., /abc.png)
    const requestPath = event.requestContext.http.path;
    const imageFileName = requestPath.replace(/^\//, '');
    console.log(`Getting ${imageFileName} from ${BUCKET_NAME}`);

    // Get image file, as Base64-encoded string
    const base64Body = await getImage(imageFileName);

    // Return image as Base64-encoded string
    response = {
      headers: {
        'content-type': 'image/jpg'
      },
      statusCode: 200,
      body: base64Body,
      isBase64Encoded: true
    };
  } catch (error) {
    // Redirect to 'Something went wrong' image
    response = {
      statusCode: 303,
      headers: {
        Location: 'https://media.giphy.com/media/l41JNsXAvFvoHvWJW/giphy.gif'
      }
    };
  }

  return response;
};
