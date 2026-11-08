// Shared by the genbot (generate.js) and genbot-retrieve (retrieve.js) functions

// Lambda functions and S3 bucket live in us-east-1
export const REGION = 'us-east-1';

// Set from the GenBotImagesBucket resource in template.yaml; the default is for local runs and tests
export const BUCKET_NAME = process.env.BUCKET_NAME ?? 'case-consulting-mgmt-genbot-images';

// Shown (generate) or redirected to (retrieve) when something goes wrong
export const ERROR_IMAGE_URL = 'https://media.giphy.com/media/l41JNsXAvFvoHvWJW/giphy.gif';
