import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { toBase64 } from '@smithy/util-base64';

// Create S3 client
const REGION = 'us-east-1';
const config = { region: REGION };
const client = new S3Client(config);

const BUCKET_NAME = 'case-consulting-mgmt-genbot-images';

// Images are never modified after creation (key is the unique request ID), so clients may cache them indefinitely
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const ERROR_IMAGE_URL = 'https://media.giphy.com/media/l41JNsXAvFvoHvWJW/giphy.gif';

// Older images in the bucket are PNG; newer images are JPEG
const CONTENT_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png'
};

/**
 * Determines image content type from file name extension.
 *
 * @param {string} imageFileName - The image file name.
 * @returns {string} The image MIME type, defaulting to image/jpeg.
 */
export const getContentType = (imageFileName) => {
  const extension = imageFileName.split('.').pop().toLowerCase();
  return CONTENT_TYPES[extension] ?? 'image/jpeg';
};

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
    // Obtain image file name from request path (e.g., /abc.jpg)
    const requestPath = event.requestContext.http.path;
    const imageFileName = requestPath.replace(/^\//, '');
    // Log who is fetching (browser vs. Basecamp server) to understand how Basecamp loads images
    console.log(`Getting ${imageFileName} from ${BUCKET_NAME} for user agent: ${event.requestContext.http.userAgent}`);

    // Get image file, as Base64-encoded string
    const base64Body = await getImage(imageFileName);

    // Return image as Base64-encoded string
    response = {
      headers: {
        'content-type': getContentType(imageFileName),
        'cache-control': IMMUTABLE_CACHE_CONTROL
      },
      statusCode: 200,
      body: base64Body,
      isBase64Encoded: true
    };
  } catch (error) {
    // Redirect to 'Something went wrong' image; don't cache, in case the failure is temporary
    response = {
      statusCode: 303,
      headers: {
        Location: ERROR_IMAGE_URL,
        'cache-control': 'no-store'
      }
    };
  }

  return response;
};
